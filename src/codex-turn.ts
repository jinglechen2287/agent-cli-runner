/**
 * One Codex turn on an app-server thread: opening (or resuming, or forking)
 * the thread, attributing notifications to the turn, steering, interrupting,
 * and settling.
 */
import {
  AbortError,
  CodexTurnError,
  runAborted,
  runTimedOut,
  SteerRejectedError,
  TimeoutError,
} from "./errors.js";
import { createDeferred, errorMessage, raceTimeout, safeCallback } from "./internal.js";
import type { CodexAppServerClient, CodexConfigOverrides } from "./codex-client.js";
import {
  createCodexAgentTracker,
  createWebToolTracker,
  isWebItem,
  itemType,
  planToolInfo,
  record,
  summarizeTool,
  text,
  threadIdFrom,
  toolInput,
  toolName,
  toUsage,
  turnIdFrom,
  turnStatus,
} from "./codex-items.js";
import type { RunCodexOptions } from "./run-codex.js";
import type { CompactionInfo, CompactionStartInfo, RunResult } from "./types.js";
import type { TokenUsage } from "./usage.js";

/** `turn/start` is acked immediately in normal operation, but a busy
 * app-server can be slow to answer; give it far more headroom than plain
 * admin requests so a loaded host does not fail turns spuriously. */
const TURN_START_TIMEOUT_MS = 60_000;
/** Ceiling on events held in the turn/start send→ack window. In normal
 * operation the ack lands within milliseconds and the buffer holds a handful
 * of entries; a server that floods past this without acking is wedged. */
const MAX_PRE_ACK_NOTIFICATIONS = 10_000;

/** Thread config for a forked side run: no web search, and every tool
 * feature off, so the copy can only answer from its history. The run adds
 * each configured MCP server, switched off by name, and still fails closed
 * on any item beyond a message or reasoning that starts anyway. */
export const CODEX_FORK_CONFIG = {
  web_search: "disabled",
  features: {
    multi_agent: false,
    multi_agent_v2: false,
    goals: false,
    shell_tool: false,
    unified_exec: false,
    apps: false,
    image_generation: false,
    view_image: false,
    sleep_tool: false,
    browser_use: false,
    computer_use: false,
  },
} as const;

/** What a forked side run may produce: talk and thought, nothing that acts. */
const FORK_ALLOWED_ITEMS: ReadonlySet<string> = new Set([
  "userMessage",
  "user_message",
  "agentMessage",
  "agent_message",
  "reasoning",
  "plan",
  "contextCompaction",
]);

export interface OpenedCodexThread {
  threadId: string;
  model?: string;
}

export function requestCodexThread(
  client: CodexAppServerClient,
  opts: Pick<
    RunCodexOptions,
    | "cwd"
    | "dangerouslyBypassApprovalsAndSandbox"
    | "developerInstructions"
    | "model"
    | "resumeSessionId"
    | "forkSessionId"
    | "forkConfig"
    | "isolated"
  > & { config?: CodexConfigOverrides; threadSource?: "user" },
): Promise<unknown> {
  /** Every fork is an ephemeral, read-only copy that asks for no approvals. */
  const forkParams = (threadId: string, config: CodexConfigOverrides | undefined) => ({
    threadId,
    cwd: opts.cwd,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.developerInstructions
      ? { developerInstructions: opts.developerInstructions }
      : {}),
    ephemeral: true,
    // Ephemeral forks of paginated threads must skip hydrating history.
    excludeTurns: true,
    sandbox: "read-only",
    approvalPolicy: "never",
    experimentalRawEvents: true,
    ...(config ? { config } : {}),
  });
  if (opts.forkSessionId && !opts.isolated) {
    // A guarded fork keeps Codex's tools: the turn's sandbox policy bounds them.
    return client.request("thread/fork", forkParams(opts.forkSessionId, opts.forkConfig));
  }
  if (opts.forkSessionId) {
    const forkSessionId = opts.forkSessionId;
    // The user's MCP servers can only be switched off by name — an empty
    // table merges with their config and leaves every one running — so read
    // what applies here first. A config that can't be read forks nothing.
    return client.request("config/read", { cwd: opts.cwd }).then((read) => client.request(
      "thread/fork",
      forkParams(forkSessionId, {
        ...CODEX_FORK_CONFIG,
        mcp_servers: Object.fromEntries(
          Object.keys(record(record(record(read)?.config)?.mcp_servers) ?? {})
            .map((name) => [name, { enabled: false }]),
        ),
      }),
    ));
  }
  // One shared params object so resumed threads can never silently diverge
  // from fresh ones (e.g. losing raw events, and with them WebFetch URLs).
  const params = {
    cwd: opts.cwd,
    experimentalRawEvents: true,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.developerInstructions
      ? { developerInstructions: opts.developerInstructions }
      : {}),
    ...(opts.dangerouslyBypassApprovalsAndSandbox
      ? { approvalPolicy: "never", sandbox: "danger-full-access" }
      : {}),
    ...(opts.config ? { config: opts.config } : {}),
  };
  return opts.resumeSessionId
    ? client.request("thread/resume", { threadId: opts.resumeSessionId, ...params })
    : client.request("thread/start", {
        ...params,
        ...(opts.threadSource ? { threadSource: opts.threadSource } : {}),
      });
}

export function openedCodexThread(value: unknown, fallbackModel?: string): OpenedCodexThread {
  const threadId = threadIdFrom(value);
  if (!threadId) throw new CodexTurnError("Codex app-server did not return a thread ID");
  const model = text(record(value)?.model) ?? fallbackModel;
  return { threadId, ...(model ? { model } : {}) };
}

/** Links turns that share one thread: a reused session can see late
 * notifications from any earlier turn before the next `turn/start` is acked,
 * and latching onto one would misattribute events across turns. */
export interface TurnContinuity {
  previousTurnIds?: ReadonlySet<string>;
  onTurnId?: (turnId: string) => void;
  /** Handed the turn's steer function when it starts, and null when it ends. */
  onSteerable?: (steer: ((prompt: string) => Promise<void>) | null) => void;
  /** Told as `turn/start` is sent, acknowledged or not. */
  onTurnStartSent?: () => void;
}

/** What a turn runs on, and who owns it. */
export interface CodexTurnContext {
  client: CodexAppServerClient;
  /** A session's thread, already open. Absent: the turn opens, resumes or
   * forks one from its options. */
  thread?: OpenedCodexThread;
  /** The client was made for this run, and closes when the turn ends. */
  ownsClient: boolean;
  /** Whether this runner may retire the app-server process when a turn/start
   * ack is lost. True for per-turn and session-owned clients; false for a
   * borrowed shared client, whose lifecycle belongs to its owner and which
   * may be running other threads' turns. */
  retireClientOnUnackedStart: boolean;
  continuity?: TurnContinuity;
  /** `turn/start` with the prompt, or `thread/compact/start`, whose reply
   * names no turn: then the turn is the one `turn/started` names. */
  start: "turn" | "compact";
}

export async function runCodexAppServerTurn(
  opts: RunCodexOptions,
  {
    client,
    thread: openedThread,
    ownsClient: ownedClient,
    retireClientOnUnackedStart,
    continuity,
    start,
  }: CodexTurnContext,
): Promise<RunResult> {
  if (opts.signal?.aborted) {
    // Before the try below: a client made for this run would outlive it.
    if (ownedClient) client.close();
    throw runAborted("codex");
  }

  const isPreviousTurn = (turnId: string): boolean =>
    continuity?.previousTurnIds?.has(turnId) ?? false;
  let threadId = openedThread?.threadId ?? opts.resumeSessionId;
  let turnId: string | undefined;
  /** Set immediately before turn/start is sent. Turn-scoped notifications
   * arriving earlier cannot belong to this turn (the server cannot have
   * started what was not yet requested), so they are dropped — closing the
   * window where a trailing event from a prior turn on a reused thread could
   * latch a stale turn id, even when no previousTurnIds set is available. */
  let turnStartSent = false;
  /** Set once the turn/start ack has named the turn. Notifications arriving
   * in the send→ack window are buffered and replayed after the ack, so a
   * trailing event from a prior turn in that window can never latch a stale
   * turn id — the ack's id is authoritative before any event is interpreted. */
  let ackReceived = false;
  const preAckNotifications: Array<{
    method: string;
    params: Record<string, unknown>;
  }> = [];
  /** A turn-tagged fatal error that arrived before the turn was identified.
   * Held until the turn/start ack (or another event) names the turn, so a
   * stale turn's trailing failure cannot settle this run while this turn's
   * own failure is still honored. */
  let pendingTurnError: { turnId: string; error: CodexTurnError } | undefined;
  const resolvePendingTurnError = (): void => {
    if (!pendingTurnError || !turnId) return;
    const held = pendingTurnError;
    pendingTurnError = undefined;
    if (held.turnId !== turnId) return;
    webTools.flush();
    settleError(held.error);
  };
  /** The single gate for turn attribution: validates an event's turn id
   * against the latch (adopting it when none is latched yet) and returns it,
   * or undefined when the event belongs to another (or a previous) turn. */
  const matchTurn = (eventTurnId: string | undefined): string | undefined => {
    if (!turnStartSent || !eventTurnId) return undefined;
    if (isPreviousTurn(eventTurnId)) return undefined;
    if (turnId && eventTurnId !== turnId) return undefined;
    if (!turnId) {
      turnId = eventTurnId;
      turnLatched.resolve();
      resolvePendingTurnError();
    }
    return eventTurnId;
  };
  /** This turn's id when an event belongs to it, latching the id if none is
   * yet: the event's thread is this one and {@link matchTurn} takes its turn. */
  const turnScoped = (params: Record<string, unknown>): string | undefined =>
    params.threadId === threadId ? matchTurn(text(params.turnId)) : undefined;
  /** Resolves once some event names this turn. */
  const turnLatched = createDeferred();
  let resolvedModel = opts.model ?? openedThread?.model;
  let finalText = "";
  let latestUsage: TokenUsage | undefined;
  let settled = false;
  let interruption: AbortError | TimeoutError | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const emittedTools = new Set<string>();

  const completion = createDeferred();
  // Notification errors can arrive while a request response is still being
  // processed. Attach a handler immediately, then await the original promise
  // below so Node never treats that legitimate ordering as unhandled.
  void completion.promise.catch(() => {});

  const lifecycle = createDeferred<never>();
  const lifecycleFailure = lifecycle.promise;
  // As with completion: a stop that lands before anything races it (say,
  // from onSessionId) must not count as unhandled.
  void lifecycleFailure.catch(() => {});

  const failLifecycle = (error: AbortError | TimeoutError): void => {
    if (lifecycle.settled) return;
    lifecycle.reject(error);
  };

  const raceLifecycle = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([operation, lifecycleFailure]);

  /** Resolves true once the turn/start ack has named the turn — what
   * `turn/steer` needs as its expected turn id — or false when the run ends
   * without one (a refused start, an ack naming no turn). */
  const turnKnown = createDeferred<boolean>();

  const steer = async (prompt: string): Promise<void> => {
    if (settled || interruption) throw new SteerRejectedError("Codex turn is already finishing");
    try {
      const known = await Promise.race([
        turnKnown.promise,
        completion.promise.then(() => {
          throw new SteerRejectedError("Codex turn ended before it could be steered");
        }),
        lifecycleFailure,
      ]);
      if (!known) throw new SteerRejectedError("Codex turn ended before it could be steered");
    } catch (error) {
      if (error instanceof SteerRejectedError) throw error;
      throw new SteerRejectedError(`Codex turn ended before it could be steered: ${errorMessage(error)}`);
    }
    if (settled || interruption || !threadId || !turnId) {
      throw new SteerRejectedError("Codex turn is already finishing");
    }
    try {
      await client.request("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      });
    } catch (error) {
      // No active turn, a different one, or one that takes no steering: the
      // host sends the words as the next turn instead.
      throw new SteerRejectedError(`Codex refused the steer: ${errorMessage(error)}`);
    }
  };
  continuity?.onSteerable?.(steer);

  const settleOk = (): void => {
    if (settled) return;
    settled = true;
    completion.resolve();
  };

  const settleError = (error: Error): void => {
    if (settled) return;
    settled = true;
    completion.reject(error);
  };

  /** Best effort: the turn may already be over. */
  const sendInterrupt = (): Promise<unknown> =>
    threadId && turnId
      ? client.request("turn/interrupt", { threadId, turnId }).catch(() => {})
      : Promise.resolve();

  const requestInterrupt = (): void => {
    const stopped = interruption;
    if (!stopped || !threadId || !turnId) return;
    void sendInterrupt().finally(() => failLifecycle(stopped));
  };

  /** A forked side run that starts anything beyond a message or reasoning —
   * a tool, a subagent, whatever a later Codex adds — is stopped and fails:
   * its config turns every tool off, so one starting means isolation did
   * not hold. An allow-list, so an item type nobody knew of fails closed. */
  const refuseForkedTool = (params: Record<string, unknown>): boolean => {
    if (!turnScoped(params)) return false;
    const item = record(params.item);
    const type = item ? text(item.type) : undefined;
    if (!item || !type || FORK_ALLOWED_ITEMS.has(type)) return false;
    const name = toolName(item) ?? type;
    void sendInterrupt();
    settleError(new CodexTurnError(`A forked side run tried to use ${name}`));
    return true;
  };

  const interrupt = (error: AbortError | TimeoutError): void => {
    if (interruption || settled) return;
    interruption = error;
    // Without a turn ID there is nothing to interrupt gracefully — fail the
    // lifecycle right away; the turn/start error path then retires an owned
    // process, which terminates any turn the server may have started
    // meanwhile (a borrowed client is left to its owner).
    if (threadId && turnId) requestInterrupt();
    else failLifecycle(error);
  };

  const abortHandler = (): void => interrupt(runAborted("codex"));
  if (opts.signal) {
    if (opts.signal.aborted) abortHandler();
    else opts.signal.addEventListener("abort", abortHandler, { once: true });
  }
  let runDeadline: number | undefined;
  if (opts.timeoutMs !== undefined) {
    runDeadline = Date.now() + opts.timeoutMs;
    timeout = setTimeout(
      () => interrupt(runTimedOut("codex", opts.timeoutMs)),
      opts.timeoutMs,
    );
  }

  const emitToolUse = (id: string, item: Record<string, unknown>): void => {
    if (emittedTools.has(id)) return;
    const name = toolName(item);
    if (!name) return;
    emittedTools.add(id);
    const summary = summarizeTool(item);
    safeCallback(() => opts.onToolUse?.({
      callId: id,
      name,
      ...(summary ? { summary } : {}),
      input: toolInput(item),
    }));
  };

  const emitToolResult = (id: string, item: Record<string, unknown>): void => {
    const exitCode = item.exitCode;
    const status = text(item.status);
    safeCallback(() => opts.onToolResult?.({
      callId: id,
      content: item,
      ...((typeof exitCode === "number" && exitCode !== 0) || status === "failed"
        ? { isError: true }
        : {}),
    }));
  };

  const webTools = createWebToolTracker({ toolUse: emitToolUse, toolResult: emitToolResult });
  const agents = createCodexAgentTracker((agent) => {
    safeCallback(() => opts.onBackgroundAgentUpdate?.(agent));
  });

  const handleItem = (method: string, params: Record<string, unknown>): void => {
    if (!turnScoped(params)) return;
    const item = record(params.item);
    if (!item) return;
    const occurredAt = typeof params.startedAtMs === "number"
      ? params.startedAtMs
      : typeof params.completedAtMs === "number" ? params.completedAtMs : Date.now();
    agents.update(item, occurredAt);

    if (itemType(item) === "contextCompaction") {
      const trigger = start === "compact" ? "manual" : "auto";
      if (method === "item/started") {
        const info: CompactionStartInfo = { trigger };
        safeCallback(() => opts.onCompactionStart?.(info));
      } else if (method === "item/completed") {
        const info: CompactionInfo = { trigger };
        safeCallback(() => opts.onCompaction?.(info));
      }
      return;
    }

    if (method === "item/completed" && itemType(item) === "agentMessage") {
      const message = text(item.text);
      if (message) {
        finalText = message;
        safeCallback(() => opts.onAssistantText?.(message));
      }
      return;
    }

    if (isWebItem(item)) {
      webTools.onWebItem(item, method === "item/completed");
      return;
    }

    const name = toolName(item);
    if (!name) return;
    const id = text(item.id) ?? `${itemType(item)}:${name}`;
    emitToolUse(id, item);
    if (method === "item/completed") emitToolResult(id, item);
  };

  const dispatchNotification = (method: string, params: Record<string, unknown>): void => {
    if (method === "turn/started" && params.threadId === threadId) {
      matchTurn(text(record(params.turn)?.id));
      if (interruption) requestInterrupt();
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      if (opts.forkSessionId && opts.isolated && method === "item/started" && refuseForkedTool(params)) return;
      handleItem(method, params);
      return;
    }
    if (method === "item/agentMessage/delta") {
      // A pooled connection multiplexes threads, and an interrupted turn can
      // trail deltas after the next one starts — both must be filtered out.
      if (!turnScoped(params)) return;
      // Raw, not the trimming text() helper: word boundaries arrive as
      // leading spaces and paragraph breaks as whitespace-only chunks, so
      // trimming here jams the streamed words together.
      const chunk = typeof params.delta === "string" ? params.delta : "";
      if (chunk) safeCallback(() => opts.onAssistantTextDelta?.(chunk));
      return;
    }
    if (method === "rawResponseItem/completed") {
      if (!turnScoped(params)) return;
      const item = record(params.item);
      if (item) webTools.onRawResponseItem(item);
      return;
    }
    if (method === "turn/plan/updated") {
      const eventTurnId = turnScoped(params);
      if (!eventTurnId) return;
      const info = planToolInfo(params, eventTurnId);
      if (info) safeCallback(() => opts.onToolUse?.(info));
      return;
    }
    if (method === "thread/tokenUsage/updated" && threadId && turnId) {
      const usage = toUsage(params, threadId, turnId, resolvedModel, opts.contextWindow);
      if (!usage) return;
      latestUsage = usage;
      safeCallback(() => opts.onUsage?.(usage));
      return;
    }
    if (method === "error" && params.threadId === threadId) {
      if (params.willRetry === true) return;
      // A turn-tagged error must pass the same attribution gate as every
      // other turn-scoped notification, or a trailing failure from an
      // aborted previous turn on a reused thread would kill this one — but
      // unlike item events it must never latch the turn id itself. Before
      // the turn is identified it is held instead, and settled or discarded
      // once the ack (or a real turn event) names the turn. An untagged
      // error is thread-fatal and settles regardless.
      const errorTurnId = text(params.turnId);
      const message = text(record(params.error)?.message) ?? "Codex turn failed";
      if (errorTurnId) {
        if (!turnStartSent || isPreviousTurn(errorTurnId)) return;
        if (!turnId) {
          pendingTurnError = {
            turnId: errorTurnId,
            error: new CodexTurnError(`Codex error: ${message}`),
          };
          return;
        }
        if (errorTurnId !== turnId) return;
      }
      webTools.flush();
      settleError(new CodexTurnError(`Codex error: ${message}`));
      return;
    }
    if (method !== "turn/completed" || params.threadId !== threadId) return;
    if (!matchTurn(text(record(params.turn)?.id))) return;
    webTools.flush();
    if (interruption) {
      failLifecycle(interruption);
      return;
    }
    const status = text(record(params.turn)?.status);
    if (status === "completed") {
      settleOk();
      return;
    }
    const message = text(record(record(params.turn)?.error)?.message)
      ?? `Codex turn ${status ?? "failed"}`;
    settleError(new CodexTurnError(message));
  };
  const removeNotification = client.onNotification((method, rawParams) => {
    const params = record(rawParams);
    if (!params) return;
    // In the send→ack window no event's turn id can be verified yet, so hold
    // everything settle-capable or host-visible and replay it (in order) once
    // the ack names the turn. turn/started is exempt: it only latches the id
    // (which the ack overrides), and when the ack is lost it is the sole
    // source of the turn id the timeout path needs for its best-effort
    // turn/interrupt.
    // Only this thread's events are worth holding; a shared client's other
    // threads flow straight through (dispatch drops them by threadId anyway).
    // An untagged error is thread-fatal and settles immediately — only
    // turn-tagged events wait for the ack to attribute them.
    const untaggedFatalError = method === "error"
      && params.willRetry !== true
      && !text(params.turnId);
    if (
      turnStartSent
      && !ackReceived
      && method !== "turn/started"
      && !untaggedFatalError
      && params.threadId === threadId
    ) {
      if (preAckNotifications.length >= MAX_PRE_ACK_NOTIFICATIONS) {
        // A server that floods events without ever acking turn/start is not
        // going to converge; fail the turn instead of buffering unboundedly.
        preAckNotifications.length = 0;
        settleError(new CodexTurnError(
          "Codex app-server flooded events without acknowledging turn/start",
        ));
        return;
      }
      preAckNotifications.push({ method, params });
      return;
    }
    dispatchNotification(method, params);
  });
  const removeClose = client.onClose((error) => settleError(error));
  const removeStderr = client.onStderr((chunk) => safeCallback(() => opts.onStderr?.(chunk)));

  try {
    const thread = openedThread ?? openedCodexThread(
      await raceLifecycle(requestCodexThread(client, opts)),
      resolvedModel,
    );
    threadId = thread.threadId;
    if (!openedThread) resolvedModel = thread.model;
    safeCallback(() => opts.onSessionId?.(thread.threadId));
    // Stopped by now (by onSessionId, say): send no turn that nothing would
    // watch.
    if (interruption) throw interruption;
    const input: Array<Record<string, unknown>> = [
      { type: "text", text: opts.prompt, text_elements: [] },
      ...(opts.imagePaths ?? []).map((path) => ({ type: "localImage", path })),
    ];
    // Cap the ack wait at the caller's remaining run budget so a silent
    // server cannot outlive a shorter opts.timeoutMs.
    const turnStartTimeoutMs = runDeadline === undefined
      ? TURN_START_TIMEOUT_MS
      : Math.max(1, Math.min(TURN_START_TIMEOUT_MS, runDeadline - Date.now()));
    let turnResult: unknown;
    turnStartSent = true;
    safeCallback(() => continuity?.onTurnStartSent?.());
    try {
      // Also raced against `completion`: a thread-fatal error or pre-ack
      // buffer overflow settles the turn while the ack is still pending, and
      // that real error should surface immediately rather than after the
      // turn/start timeout expires. One flat race — an extra nesting level
      // would add a microtask hop and reorder ack handling against a
      // same-tick abort.
      const startDeadline = Date.now() + turnStartTimeoutMs;
      turnResult = await Promise.race([
        start === "compact"
          ? client.request("thread/compact/start", { threadId }, turnStartTimeoutMs)
          : client.request("turn/start", {
              threadId,
              input,
              cwd: opts.turnCwd ?? opts.cwd,
              ...(opts.model ? { model: opts.model } : {}),
              ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
              ...(opts.serviceTier !== undefined ? { serviceTier: opts.serviceTier } : {}),
              ...(opts.sandboxPolicy ? { sandboxPolicy: opts.sandboxPolicy } : {}),
            }, turnStartTimeoutMs),
        completion.promise.then(() => {
          throw new CodexTurnError("Codex turn settled before turn/start was acknowledged");
        }),
        lifecycleFailure,
      ]);
      if (start === "compact") {
        // The reply names no turn; `turn/started` does, before or after it.
        // Events in between pass straight through the attribution gate, which
        // still drops every earlier turn's.
        ackReceived = true;
        for (const entry of preAckNotifications.splice(0)) {
          dispatchNotification(entry.method, entry.params);
        }
        if (!turnId) {
          await raceTimeout(
            [
              turnLatched.promise,
              completion.promise.then(() => {
                throw new CodexTurnError("Codex compaction settled before it started");
              }),
              lifecycleFailure,
            ],
            Math.max(1, startDeadline - Date.now()),
            () => new TimeoutError("Codex app-server did not start the compaction"),
          );
        }
      }
    } catch (error) {
      // The turn may have started server-side despite the lost ack, and an
      // unacked start cannot be trusted to unwind before the thread is
      // reused: best-effort interrupt when the turn is identifiable, then
      // retire the app-server process when this runner or its session owns
      // it (the session reports `closed`; its host starts a fresh one). A
      // borrowed shared client stays up — other threads may be mid-turn on
      // it — so its owner decides whether to retire it.
      if ((error instanceof TimeoutError || error instanceof AbortError) && threadId) {
        if (!interruption) void sendInterrupt();
        if (retireClientOnUnackedStart) client.close();
      }
      throw error;
    }
    turnId = turnIdFrom(turnResult) ?? turnId;
    ackReceived = true;
    // Replay the send→ack window in arrival order, now that events can be
    // attributed against the ack's authoritative turn id. When the ack named
    // no turn, the replayed turn/started may still latch one.
    for (const entry of preAckNotifications.splice(0)) {
      dispatchNotification(entry.method, entry.params);
    }
    if (!turnId) throw new CodexTurnError("Codex app-server did not return a turn ID");
    turnKnown.resolve(true);
    resolvePendingTurnError();
    if (interruption) requestInterrupt();
    const ackStatus = turnStatus(turnResult);
    // Both status spellings, mirroring the item handlers' defensiveness.
    const ackTerminal = ackStatus !== undefined
      && ackStatus !== "completed"
      && ackStatus !== "inProgress"
      && ackStatus !== "in_progress";
    let exitCode = 0;
    if (ackTerminal && !settled) {
      // The ack already reports the turn finished (failed/rejected); no
      // further notifications are guaranteed, so waiting on turn/completed
      // could hang forever. Settle now with the nonzero exit the terminal
      // status describes.
      settled = true;
      exitCode = 1;
    } else {
      await raceLifecycle(completion.promise);
      if (ackTerminal) exitCode = 1;
    }
    return {
      text: finalText.trim(),
      exitCode,
      sessionId: thread.threadId,
      ...(latestUsage ? { usage: latestUsage } : {}),
    };
  } finally {
    continuity?.onSteerable?.(null);
    // A steer still waiting for the turn's id gets none.
    turnKnown.resolve(false);
    if (timeout) clearTimeout(timeout);
    webTools.flush();
    opts.signal?.removeEventListener("abort", abortHandler);
    removeNotification();
    removeClose();
    removeStderr();
    const finishedTurnId = turnId;
    if (finishedTurnId) safeCallback(() => continuity?.onTurnId?.(finishedTurnId));
    if (ownedClient) client.close();
  }
}
