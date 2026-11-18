import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID, type UUID } from "node:crypto";
import {
  query as sdkQuery,
  type EffortLevel,
  type ElicitationRequest,
  type ElicitationResult,
  type HookCallbackMatcher,
  type HookEvent,
  type McpServerConfig,
  type Options,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions as SdkSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { createClaudeMcpStatus, MCP_STATUS_POLL_LIMIT_MS } from "./claude-mcp-status.js";
import {
  createClaudeSessionState,
  createClaudeTurnTranslator,
  knownContextWindow,
  type ClaudeTurnOutcome,
  type ClaudeTurnTranslator,
} from "./claude-messages.js";
import { MissingCliError, runAborted, runTimedOut, SteerRejectedError } from "./errors.js";
import {
  answerMcpElicitation,
  createDeferred,
  isRecord,
  raceTimeout,
  safeCallback,
  withoutUndefined,
  type Deferred,
} from "./internal.js";
import {
  childEnv,
  createChunkDecoder,
  resolveExecutable,
  signalProcessTree,
  spawnCli,
  terminateTree,
} from "./process.js";
import type { AgentCallbacks, McpElicitationRequest, RunResult, SpawnFn } from "./types.js";
import { tokenUsage, type TokenUsage } from "./usage.js";

/** Claude Code permission modes. `manual` is this package's name for the
 * CLI's `default` (prompt-for-everything) mode. */
export type ClaudePermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "manual"
  | "dontAsk"
  | "plan";

/** In-process hook callbacks, keyed by hook event — the Agent SDK's shape. */
export type ClaudeHooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

/** The slice of the Agent SDK's `Query` a session drives. */
export interface ClaudeQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  close(): void;
  /** Absent on a scripted query that doesn't model it. */
  mcpServerStatus?(): Promise<ReadonlyArray<{ name: string; status: string; error?: string }>>;
  /** The data behind `/context`. Absent on a scripted query that doesn't model it. */
  getContextUsage?(opts?: { detail?: "summary" | "full" }): Promise<ClaudeContextUsage>;
}

/** The slice of the Agent SDK's context-usage answer a session reads. */
export interface ClaudeContextUsage {
  /** Tokens the context holds now, counted with the token-count API. */
  totalTokens: number;
  /** The window those tokens are measured against. */
  maxTokens?: number;
  model?: string;
}

/** The Agent SDK's `query()`, narrowed to the streaming-input form a session
 * uses. Injectable so tests can script the message stream. */
export type ClaudeQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQuery;

/** How long an interrupted turn may take to deliver its `result` before the
 * process is killed without waiting for it. */
export const CLAUDE_INTERRUPT_GRACE_MS = 5_000;

/** How long a turn held open for a subagent waits in silence, once every
 * subagent has settled, for the CLI to answer the notification with a
 * `result` before the turn settles without it. */
export const CLAUDE_FOLLOW_UP_GRACE_MS = 60_000;
/** How long a held turn waits for the CLI to open an answer to a subagent's
 * notification once nothing else is owed: it opens one at once, so silence
 * this long means the last answer already took the notification in. */
export const CLAUDE_ABSORBED_FOLLOW_UP_GRACE_MS = 5_000;

/** How long measuring the context after a compaction may take before the
 * turn settles without a size. */
const CONTEXT_MEASURE_TIMEOUT_MS = 10_000;

/** What a host can answer, or undefined for a URL request with no URL. A form
 * with no schema asks only for a yes. */
function claudeElicitationRequest(request: ElicitationRequest): McpElicitationRequest | undefined {
  const { serverName, message } = request;
  if (request.mode === "url") {
    return request.url ? { serverName, message, mode: "url", url: request.url } : undefined;
  }
  return {
    serverName,
    message,
    mode: "form",
    requestedSchema: request.requestedSchema ?? { type: "object", properties: {} },
  };
}

export interface CreateClaudeSessionOptions {
  cwd: string;
  /** Path or name of the `claude` binary, resolved through PATH. Defaults to
   * "claude". The SDK's bundled binary is never used. */
  executablePath?: string;
  /** Base environment for the CLI. Defaults to process.env. Nesting-guard
   * variables are stripped from it either way. */
  env?: NodeJS.ProcessEnv;
  /** Pre-assign the id of a new session. Mutually exclusive with resumeSessionId. */
  newSessionId?: string;
  /** Resume an existing session by id. Mutually exclusive with newSessionId. */
  resumeSessionId?: string;
  /** Model alias or id. Omitted = the CLI's configured default. */
  model?: string;
  /** "low" | "medium" | "high" | "xhigh" | "max". Omitted = the model's default. */
  effort?: string;
  /** Fixed for the life of the session. Omitted = the CLI's settings default. */
  permissionMode?: ClaudePermissionMode;
  /** Built-in tools: `["default"]` is the full Claude Code set; an explicit
   * `[]` disables every built-in. Omitted = the SDK default. */
  tools?: string[];
  /** Tools pre-approved without a permission check. Auto-allow only — this
   * never restricts the tool set. */
  allowedTools?: string[];
  /** Tools removed from the model's context. */
  disallowedTools?: string[];
  /** Settings sources the CLI may load. Omitted = all of them. */
  settingSources?: Array<"user" | "project" | "local">;
  /** Extra flag settings: a JSON string, a file path, or an object. */
  settings?: string | Record<string, unknown>;
  /** Appended to the Claude Code system prompt. */
  appendSystemPrompt?: string;
  /** In-process hook callbacks (e.g. a PreToolUse guard). */
  hooks?: ClaudeHooks;
  /** MCP servers for the session, by name, on top of those the settings
   * sources configure. */
  mcpServers?: Record<string, McpServerConfig>;
  /** A non-persistent session with customizations, tools, and MCP disabled,
   * for small metadata tasks such as chat titles. */
  isolated?: boolean;
  /** Fork this existing session for a side run: it sees that session's
   * history and writes nothing back. With `isolated` it may use no tool;
   * without, it keeps the tools, permission mode, settings and hooks given
   * here, as any guarded session would. Mutually exclusive with
   * newSessionId and resumeSessionId. */
  forkSessionId?: string;
  /** Override {@link CLAUDE_INTERRUPT_GRACE_MS}. */
  interruptGraceMs?: number;
  /** Override {@link CLAUDE_FOLLOW_UP_GRACE_MS}. */
  followUpGraceMs?: number;
  /** Override {@link CLAUDE_ABSORBED_FOLLOW_UP_GRACE_MS}. */
  absorbedFollowUpGraceMs?: number;
  spawnFn?: SpawnFn;
  queryFn?: ClaudeQueryFn;
}

export type ClaudeSessionTurnOptions = AgentCallbacks & {
  prompt: string;
  /** Aborting interrupts the turn, rejects with an AbortError, and closes the
   * session once the CLI has finished the interrupt (or after the grace
   * period); the next turn resumes from disk in a new session. */
  signal?: AbortSignal;
  /** Wall-clock limit for the turn, using the same interrupt path; rejects
   * with a TimeoutError. */
  timeoutMs?: number;
};

export type ClaudeSessionCompactOptions = AgentCallbacks & {
  /** What the summary should keep, as typed after Claude Code's `/compact`. */
  instructions?: string;
  /** As on {@link ClaudeSessionTurnOptions}. */
  signal?: AbortSignal;
  timeoutMs?: number;
};

export interface ClaudeSessionSteerOptions {
  /** More input for the running turn, as the user would type it mid-turn. */
  prompt: string;
}

export interface ClaudeSession {
  /** The Claude session id: the pre-assigned or resumed id. */
  readonly sessionId: string;
  readonly cwd: string;
  readonly closed: boolean;
  /** Run one turn. Rejects when another turn is active or the session is closed. */
  runTurn(options: ClaudeSessionTurnOptions): Promise<RunResult>;
  /** Compact the conversation with Claude Code's own `/compact`, as a turn of
   * its own: it settles with empty text, and reports the size left through
   * `onUsage` and the result's `usage` when the CLI can measure it. It can't
   * be steered. */
  compact(options: ClaudeSessionCompactOptions): Promise<RunResult>;
  /** Hand more input to the running turn. The CLI reads it at the turn's next
   * tool round, or answers it as a turn of its own right after — either way
   * the running turn settles only once it is answered. Rejects with a
   * {@link SteerRejectedError} when no turn is running or the turn is past
   * taking more: interrupted, or its result already in. */
  steer(options: ClaudeSessionSteerOptions): Promise<void>;
  /** Called once, with the reason, when the session closes for any reason. */
  onClose(handler: (error: Error) => void): () => void;
  /** Terminate the CLI process tree. Resolves once it has exited. */
  close(): Promise<void>;
}

interface ActiveTurn {
  translator: ClaudeTurnTranslator;
  /** Started by {@link ClaudeSession.compact}. */
  compact: boolean;
  /** A compaction's result is in, and the CLI is counting what is left. It
   * is still the active turn until that ends. */
  measuring: boolean;
  callbacks: AgentCallbacks;
  interruption: "abort" | "timeout" | null;
  timeoutMs: number | undefined;
  /** Running while the turn waits on the CLI's follow-up `result`. */
  followUpTimer: ReturnType<typeof setTimeout> | undefined;
  /** Fires when the turn is over, so a request still waiting on the user ends. */
  elicitations: AbortController;
  /** When this turn stops looking again for a server still connecting. */
  mcpPollDeadline: number;
  resolve(result: RunResult): void;
  reject(error: Error): void;
}

/** Message types that only ever belong to a turn. One arriving between turns
 * means the CLI woke itself up (a background task finished, say). */
const TURN_MESSAGE_TYPES = new Set(["assistant", "user", "stream_event", "result"]);

/** Most of the stderr tail kept for a process-exit error. */
const STDERR_TAIL_CHARS = 2_000;

function validateSessionOptions(opts: CreateClaudeSessionOptions): void {
  if (opts.newSessionId && opts.resumeSessionId) {
    throw new Error(
      "newSessionId and resumeSessionId are mutually exclusive — pass one or the other",
    );
  }
  if (opts.forkSessionId && (opts.newSessionId || opts.resumeSessionId)) {
    throw new Error(
      "forkSessionId is mutually exclusive with newSessionId and resumeSessionId",
    );
  }
  if (opts.isolated && opts.resumeSessionId) {
    throw new Error("isolated Claude runs cannot resume a session");
  }
  if (opts.isolated && opts.permissionMode) {
    throw new Error("isolated Claude runs cannot set a permission mode");
  }
  if (opts.isolated && opts.tools) {
    throw new Error("isolated Claude runs cannot set tools — isolated already disables them all");
  }
  if (opts.isolated && opts.mcpServers) {
    throw new Error("isolated Claude runs cannot set MCP servers — isolated already disables MCP");
  }
}

/** A forked side run's backstop. Its tool list is already empty, but the
 * copied history names tools the model may still reach for: refuse them all. */
const DENY_EVERY_TOOL: HookCallbackMatcher = {
  matcher: "*",
  hooks: [
    async () => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: "A forked side run may not use tools.",
      },
    }),
  ],
};

function sdkTools(tools: string[] | undefined): Options["tools"] | undefined {
  if (!tools) return undefined;
  if (tools.length === 1 && tools[0] === "default") return { type: "preset", preset: "claude_code" };
  // An explicit [] stays [] — every built-in disabled — and never widens back
  // to the full set.
  return [...tools];
}

/** Build the Agent SDK options for a session. Exported for tests. */
export function claudeSessionQueryOptions(
  opts: CreateClaudeSessionOptions,
  sessionId: string,
  executablePath: string,
  spawnClaudeCodeProcess: (options: SdkSpawnOptions) => SpawnedProcess,
): Options {
  const permissionMode = opts.permissionMode === "manual" ? "default" : opts.permissionMode;
  const tools = opts.isolated ? [] : sdkTools(opts.tools);
  return {
    cwd: opts.cwd,
    env: childEnv("claude", opts.env ?? process.env),
    pathToClaudeCodeExecutable: executablePath,
    spawnClaudeCodeProcess,
    // A fork names its own id alongside the session it copies.
    ...(opts.forkSessionId
      ? { resume: opts.forkSessionId, forkSession: true, sessionId }
      : opts.resumeSessionId ? { resume: opts.resumeSessionId } : { sessionId }),
    // Omitting systemPrompt sends an empty one, not Claude Code's.
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(opts.appendSystemPrompt ? { append: opts.appendSystemPrompt } : {}),
    },
    includePartialMessages: true,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort as EffortLevel } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(opts.allowedTools?.length ? { allowedTools: [...opts.allowedTools] } : {}),
    ...(opts.disallowedTools?.length ? { disallowedTools: [...opts.disallowedTools] } : {}),
    ...(opts.settingSources ? { settingSources: [...opts.settingSources] } : {}),
    ...(opts.settings !== undefined ? { settings: opts.settings as NonNullable<Options["settings"]> } : {}),
    // An isolated fork has no tools, and refuses any it reaches for anyway; a
    // guarded fork keeps the caller's tools and guard as they are.
    ...(opts.forkSessionId && opts.isolated
      ? { hooks: { ...opts.hooks, PreToolUse: [DENY_EVERY_TOOL, ...(opts.hooks?.PreToolUse ?? [])] } }
      : opts.hooks ? { hooks: opts.hooks } : {}),
    ...(opts.mcpServers ? { mcpServers: { ...opts.mcpServers } } : {}),
    ...(opts.isolated
      ? { strictMcpConfig: true, persistSession: false, extraArgs: { "safe-mode": null } }
      : opts.forkSessionId ? { persistSession: false } : {}),
  };
}

/** A user message for the CLI's input, stamped with `uuid`. `priority: "next"`
 * has the CLI read it between tool rounds of the running turn. */
function userMessage(prompt: string, uuid: UUID, priority?: "next"): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
    uuid,
    ...(priority ? { priority } : {}),
  };
}

/** The SDK's view of a spawned CLI: its pipes, its state, and a kill that
 * reaches the process tree. */
function toSpawnedProcess(child: ChildProcess): SpawnedProcess {
  if (!child.stdin || !child.stdout) {
    throw new Error("Claude process was spawned without stdio pipes");
  }
  const stdin = child.stdin;
  const stdout = child.stdout;
  return {
    stdin,
    stdout,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill(signal) {
      signalProcessTree(child, signal);
      return true;
    },
    on: child.on.bind(child) as SpawnedProcess["on"],
    once: child.once.bind(child) as SpawnedProcess["once"],
    off: child.off.bind(child) as SpawnedProcess["off"],
  };
}

/** A queue the SDK reads user messages from. Ending it closes the CLI's stdin. */
function createInputQueue(): {
  push(message: SDKUserMessage): void;
  end(): void;
  iterable: AsyncIterable<SDKUserMessage>;
} {
  const pending: SDKUserMessage[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  return {
    push(message) {
      pending.push(message);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const next = pending.shift();
          if (next) {
            yield next;
            continue;
          }
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      },
    },
  };
}

/** Start a long-lived Claude Code session over the Agent SDK. Turns run one at
 * a time through {@link ClaudeSession.runTurn}; the CLI process stays up
 * between them. Startup failures surface on the first turn. */
export async function createClaudeSession(
  opts: CreateClaudeSessionOptions,
): Promise<ClaudeSession> {
  validateSessionOptions(opts);
  const env = opts.env ?? process.env;
  const executablePath = resolveExecutable(opts.executablePath ?? "claude", env, { cwd: opts.cwd });
  if (!executablePath) throw new MissingCliError("claude");
  const sessionId = opts.resumeSessionId ?? opts.newSessionId ?? randomUUID();
  const spawnFn = opts.spawnFn ?? nodeSpawn;
  const queryFn: ClaudeQueryFn = opts.queryFn ?? sdkQuery;
  const interruptGraceMs = opts.interruptGraceMs ?? CLAUDE_INTERRUPT_GRACE_MS;
  const followUpGraceMs = opts.followUpGraceMs ?? CLAUDE_FOLLOW_UP_GRACE_MS;
  const absorbedFollowUpGraceMs = opts.absorbedFollowUpGraceMs ?? CLAUDE_ABSORBED_FOLLOW_UP_GRACE_MS;
  /** Some `result` of this process named its prompt, so one that names none
   * is never a turn's own. */
  let cliEchoesPromptUuid = false;
  /** Carried across turns: the qualified model and the windows results reported. */
  const sessionState = createClaudeSessionState();

  let closed = false;
  let child: ChildProcess | undefined;
  /** Settles when the latest child exits. */
  let childExit: Deferred<void> | undefined;
  let active: ActiveTurn | undefined;
  let stderrTail = "";
  const closeHandlers = new Set<(error: Error) => void>();
  const input = createInputQueue();

  const spawnClaudeCodeProcess = (spawnOptions: SdkSpawnOptions): SpawnedProcess => {
    // A process-group leader (POSIX), so killing the session reaches tool
    // children (a running Bash) as well as the CLI.
    const spawned = spawnCli({
      cli: "claude",
      spawnFn,
      command: spawnOptions.command,
      args: spawnOptions.args,
      cwd: spawnOptions.cwd ?? opts.cwd,
      env: spawnOptions.env,
    });
    const exited = createDeferred();
    child = spawned;
    childExit = exited;
    spawned.once("exit", () => exited.resolve());
    // Always drained: an unread stderr pipe would eventually block the CLI.
    const stderr = createChunkDecoder((text) => {
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
      const callbacks = active?.callbacks;
      safeCallback(() => callbacks?.onStderr?.(text));
    });
    spawned.stderr?.on("data", (chunk: Buffer | string) => stderr.push(chunk));
    spawned.stderr?.on("end", () => stderr.flush());
    spawnOptions.signal.addEventListener("abort", () => signalProcessTree(spawned, "SIGKILL"), {
      once: true,
    });
    return toSpawnedProcess(spawned);
  };

  const onElicitation: NonNullable<Options["onElicitation"]> = (request, { signal }) => {
    const turn = active;
    const elicitation = claudeElicitationRequest(request);
    if (!turn || !elicitation) return Promise.resolve({ action: "decline" });
    // A host's answer is typed loosely on purpose; the MCP server validates it.
    return answerMcpElicitation(turn.callbacks.onMcpElicitation, elicitation, [
      signal,
      turn.elicitations.signal,
    ]) as Promise<ElicitationResult>;
  };
  const options: Options = {
    ...claudeSessionQueryOptions(opts, sessionId, executablePath, spawnClaudeCodeProcess),
    ...(opts.isolated ? {} : { onElicitation }),
  };
  const runtime = queryFn({ prompt: input.iterable, options });

  const mcpStatus = createClaudeMcpStatus(runtime, () => active);

  const killTree = (): Promise<void> => {
    const current = child;
    const exited = childExit;
    if (!current || !exited || exited.settled) return Promise.resolve();
    return terminateTree((signal) => signalProcessTree(current, signal), exited, { unref: true });
  };

  const interruptionError = (turn: ActiveTurn): Error =>
    turn.interruption === "timeout"
      ? runTimedOut("claude", turn.timeoutMs)
      : runAborted("claude");

  let closing: Promise<void> | undefined;
  let closeReason: Error | undefined;
  const closeWith = (reason: Error): Promise<void> => {
    if (closing) return closing;
    closed = true;
    closeReason = reason;
    const turn = active;
    active = undefined;
    if (turn) turn.reject(turn.interruption ? interruptionError(turn) : reason);
    for (const handler of closeHandlers) safeCallback(() => handler(reason));
    closeHandlers.clear();
    input.end();
    try {
      runtime.close();
    } catch {
      // The query may already have shut down.
    }
    closing = killTree();
    return closing;
  };

  /** What the context holds now, by the CLI's own count; undefined when it
   * can't say in time. Best effort: a size is never worth failing a turn. */
  const measureContext = async (): Promise<TokenUsage | undefined> => {
    if (!runtime.getContextUsage) return undefined;
    try {
      const measured = await raceTimeout(
        [runtime.getContextUsage({ detail: "full" })],
        CONTEXT_MEASURE_TIMEOUT_MS,
        () => new Error("timed out"),
        { unref: true },
      );
      const total = measured.totalTokens;
      if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return undefined;
      // The init line's model keeps its window marker (`[1m]`); the answer's
      // may not.
      const model = sessionState.model ?? measured.model;
      const reported = typeof measured.maxTokens === "number" && measured.maxTokens > 0
        ? measured.maxTokens
        : undefined;
      return tokenUsage(
        { contextTokens: Math.round(total), inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        model,
        knownContextWindow(sessionState, model) ?? reported,
      );
    } catch {
      return undefined;
    }
  };

  const exitError = (cause?: unknown): Error => {
    const detail = cause instanceof Error ? cause.message : "Claude process exited";
    const tail = stderrTail.trim();
    return new Error(tail && !detail.includes(tail) ? `${detail}: ${tail}` : detail);
  };

  const settleTurn = (turn: ActiveTurn): void => {
    if (active !== turn || turn.measuring) return;
    const outcome = turn.translator.finish();
    // A compaction makes no request whose usage would say what is left, so
    // the turn asks the CLI to count it before handing the result back. It
    // stays the active turn meanwhile: no other turn starts, and a stop or
    // a close still ends it.
    if (!turn.interruption && turn.compact && !outcome.isError && turn.translator.compacted && !outcome.usage) {
      turn.measuring = true;
      void measureContext().then((usage) => {
        // Stopped or closed while counting: already settled.
        if (active !== turn) return;
        turn.measuring = false;
        if (usage) safeCallback(() => turn.callbacks.onUsage?.(usage));
        finishTurn(turn, outcome, usage);
      });
      return;
    }
    finishTurn(turn, outcome);
  };

  const finishTurn = (turn: ActiveTurn, outcome: ClaudeTurnOutcome, measured?: TokenUsage): void => {
    active = undefined;
    if (turn.interruption) {
      turn.reject(interruptionError(turn));
    } else {
      turn.resolve({
        text: outcome.text,
        exitCode: outcome.isError ? 1 : 0,
        ...withoutUndefined({ sessionId: outcome.sessionId, usage: measured ?? outcome.usage }),
      });
    }
    // A stopped turn ends the process once the CLI has finished the interrupt
    // (so its transcript is written). Kept alive, the process would hand the
    // stopped request to the model again with the next prompt — an interrupt
    // that lands before any output leaves it unanswered. Resuming from disk
    // does not.
    if (turn.interruption) {
      void closeWith(new Error("Claude session closed after an interrupted turn"));
      return;
    }
    // A subagent holds its turn open until it reports back (see the message
    // loop), but a background shell or Monitor does not: one still running at
    // the result would otherwise wake the CLI between turns.
    if (turn.translator.liveTaskIds.size > 0) {
      void closeWith(new Error("Claude left background tasks running at the end of a turn"));
    }
  };

  void (async () => {
    try {
      for await (const message of runtime) {
        const turn = active;
        if (!turn) {
          const type = isRecord(message) ? message.type : undefined;
          if (typeof type === "string" && TURN_MESSAGE_TYPES.has(type)) {
            void closeWith(new Error("Claude produced output outside a turn"));
            return;
          }
          continue;
        }
        if (
          isRecord(message)
          && message.type === "system"
          && message.subtype === "init"
          && Array.isArray(message.mcp_servers)
        ) {
          mcpStatus.fromInit(message.mcp_servers);
        }
        turn.translator.handle(message);
        if (turn.translator.echoedPromptUuid) cliEchoesPromptUuid = true;
        if (turn.translator.done) {
          settleTurn(turn);
        } else if (turn.translator.awaitingFollowUp) {
          // Every subagent has reported back and the CLI is answering the
          // notification. Any message shows it is still at it, so only a
          // silent gap ends the wait — the thread is not held forever by a
          // CLI that never answers.
          if (turn.followUpTimer) clearTimeout(turn.followUpTimer);
          turn.followUpTimer = setTimeout(
            () => settleTurn(turn),
            turn.translator.followUpMayBeAbsorbed ? absorbedFollowUpGraceMs : followUpGraceMs,
          );
        } else if (turn.followUpTimer) {
          clearTimeout(turn.followUpTimer);
          turn.followUpTimer = undefined;
        }
      }
      void closeWith(exitError());
    } catch (error) {
      void closeWith(exitError(error));
    }
  })();

  const startTurn = (turnOptions: ClaudeSessionTurnOptions, compact: boolean): Promise<RunResult> => {
    // The close reason carries the CLI's stderr tail when it died on its
    // own, so a host that never subscribed to onClose still sees why.
    if (closed) return Promise.reject(closeReason ?? new Error("Claude session is closed"));
    if (active) return Promise.reject(new Error("Claude session already has an active turn"));
    const { prompt, signal, timeoutMs, ...callbacks } = turnOptions;
    if (signal?.aborted) return Promise.reject(runAborted("claude"));

    return new Promise<RunResult>((resolve, reject) => {
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (graceTimer) clearTimeout(graceTimer);
        if (turn.followUpTimer) clearTimeout(turn.followUpTimer);
        signal?.removeEventListener("abort", onAbort);
        mcpStatus.stopPoll();
        turn.elicitations.abort();
      };
      // Stamped so the turn's result can be told apart from one the CLI
      // writes for something else — a task an earlier process left running.
      const promptUuid = randomUUID();
      const turn: ActiveTurn = {
        compact,
        measuring: false,
        translator: createClaudeTurnTranslator(callbacks, {
          promptUuid,
          cliEchoesPromptUuid,
          session: sessionState,
        }),
        callbacks,
        interruption: null,
        timeoutMs,
        followUpTimer: undefined,
        elicitations: new AbortController(),
        mcpPollDeadline: Date.now() + MCP_STATUS_POLL_LIMIT_MS,
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const interrupt = (kind: "abort" | "timeout"): void => {
        if (active !== turn || turn.interruption) return;
        turn.interruption = kind;
        // The compaction is done and written; only the count is left, and
        // nothing in the CLI needs stopping.
        if (turn.measuring) {
          active = undefined;
          turn.reject(interruptionError(turn));
          return;
        }
        runtime.interrupt().catch(() => {});
        // Past its own result the turn is only waiting on subagents, and an
        // idle CLI writes no result for the interrupt: the session goes now.
        if (turn.translator.resultSeen) {
          void closeWith(new Error("Claude session closed after an interrupted turn"));
          return;
        }
        // The interrupted turn still ends with a `result`; if it never
        // arrives, the process is wedged and goes.
        graceTimer = setTimeout(() => {
          if (active === turn) void closeWith(new Error("Claude did not stop after an interrupt"));
        }, interruptGraceMs);
      };
      const onAbort = (): void => interrupt("abort");
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined) {
        timeoutTimer = setTimeout(() => interrupt("timeout"), timeoutMs);
      }
      active = turn;
      input.push(userMessage(prompt, promptUuid));
      // After the prompt: a status callback that steers queues behind it.
      mcpStatus.turnStarted();
    });
  };

  return {
    sessionId,
    cwd: opts.cwd,
    get closed() {
      return closed;
    },
    runTurn(turnOptions: ClaudeSessionTurnOptions): Promise<RunResult> {
      return startTurn(turnOptions, false);
    },
    compact({ instructions, ...turnOptions }: ClaudeSessionCompactOptions): Promise<RunResult> {
      const focus = instructions?.trim();
      return startTurn({ ...turnOptions, prompt: focus ? `/compact ${focus}` : "/compact" }, true);
    },
    steer({ prompt }: ClaudeSessionSteerOptions): Promise<void> {
      if (closed) return Promise.reject(new SteerRejectedError("Claude session is closed"));
      const turn = active;
      if (!turn) return Promise.reject(new SteerRejectedError("Claude session has no active turn"));
      if (turn.interruption) {
        return Promise.reject(new SteerRejectedError("Claude turn is being interrupted"));
      }
      if (turn.compact) {
        return Promise.reject(new SteerRejectedError("Claude is compacting the conversation"));
      }
      // Past its result the turn is wrapping up or only waiting on subagents;
      // a steer now would wake the CLI into a turn nobody is waiting for.
      if (turn.translator.resultSeen) {
        return Promise.reject(new SteerRejectedError("Claude turn is already finishing"));
      }
      const uuid = randomUUID();
      turn.translator.expectUserMessage(uuid);
      // Read between tool rounds of the running turn, not held until it ends.
      input.push(userMessage(prompt, uuid, "next"));
      return Promise.resolve();
    },
    onClose(handler) {
      if (closed) {
        safeCallback(() => handler(closeReason ?? new Error("Claude session is closed")));
        return () => {};
      }
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close() {
      return closeWith(new Error("Claude session closed"));
    },
  };
}
