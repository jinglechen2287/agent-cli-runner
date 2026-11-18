/**
 * Long-lived Codex sessions on one app-server thread, and one-off app-server
 * runs.
 */
import { AbortError, SteerRejectedError, UnsupportedServerRequestError } from "./errors.js";
import { answerMcpElicitation, safeCallback } from "./internal.js";
import {
  createCodexAppServerClient,
  startCodexAppServer,
  type CodexConfigOverrides,
} from "./codex-client.js";
import { codexElicitationRequest, codexMcpStatus, record, text } from "./codex-items.js";
import {
  openedCodexThread,
  requestCodexThread,
  runCodexAppServerTurn,
  type OpenedCodexThread,
} from "./codex-turn.js";
import type { RunCodexOptions } from "./run-codex.js";
import type { AgentCallbacks, McpServerStatusInfo, RunResult } from "./types.js";

export type CodexAppServerTurnOptions = Omit<
  RunCodexOptions,
  | "appServerClient"
  | "appServerSession"
  | "cwd"
  | "dangerouslyBypassApprovalsAndSandbox"
  | "developerInstructions"
  | "env"
  | "executablePath"
  | "isolated"
  | "resumeSessionId"
  | "forkSessionId"
  | "forkConfig"
  | "spawnFn"
>;

export interface CodexAppServerSession {
  readonly threadId: string;
  readonly cwd: string;
  readonly closed: boolean;
  runTurn(options: CodexAppServerTurnOptions): Promise<RunResult>;
  /** Hand more input to the running turn through `turn/steer`, once the turn
   * is identified. Rejects with a {@link SteerRejectedError} when no turn is
   * running, the turn ends first, or the app-server refuses the steer. */
  steer(options: CodexAppServerSteerOptions): Promise<void>;
  /** Compact the thread with Codex's own `thread/compact/start`, as a turn of
   * its own: it settles with empty text, and reports Codex's estimate of the
   * compacted history through `onUsage`. It can't be steered. */
  compact(options: CodexAppServerCompactOptions): Promise<RunResult>;
  onClose(handler: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export type CodexAppServerCompactOptions = AgentCallbacks & {
  /** As on a turn: aborting interrupts the compaction. */
  signal?: AbortSignal;
  timeoutMs?: number;
};

export interface CodexAppServerSteerOptions {
  /** More input for the running turn, as the user would type it mid-turn. */
  prompt: string;
}

export interface CreateCodexAppServerSessionOptions {
  cwd: string;
  executablePath?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: RunCodexOptions["spawnFn"];
  requestTimeoutMs?: number;
  resumeSessionId?: string;
  model?: string;
  developerInstructions?: string;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  /** Config overrides for the thread, sent on `thread/start` and
   * `thread/resume` — e.g. `{ mcp_servers: { name: { url } } }`. */
  config?: CodexConfigOverrides;
  /** Archive the thread with `thread/archive` when the session closes, once
   * it has run a turn: the rollout moves to Codex's archived sessions, kept
   * on disk but out of the history a Codex client lists by default. */
  archive?: boolean;
  /** How long close waits for the archive; 2 s unless given. */
  archiveTimeoutMs?: number;
  /** Told the thread's id when close couldn't archive it: Codex refused, didn't
   * answer in time, or had already exited. The session closes all the same. */
  onArchiveError?: (threadId: string, error: Error) => void;
}

/** How long a closing session waits for `thread/archive`. */
const ARCHIVE_TIMEOUT_MS = 2000;

/** Declared so Codex hands a full-access turn's MCP forms to the client. It also
 * needs the thread to be a user's, which `thread/start` states and a resumed
 * thread keeps. */
const FORM_INPUT_EXTENSION = "openai/standard-form-input";

export async function createCodexAppServerSession(
  options: CreateCodexAppServerSessionOptions,
): Promise<CodexAppServerSession> {
  const { client, whenExited } = await startCodexAppServer({
    cwd: options.cwd,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
    extensions: { [FORM_INPUT_EXTENSION]: {} },
  });

  let activeTurn: { callbacks: AgentCallbacks; elicitations: AbortController } | undefined;
  let threadId: string | undefined;
  const previousTurnIds = new Set<string>();
  /** Requests a callback is answering, so Codex can say one is over. */
  const openElicitations = new Map<number | string, AbortController>();
  const mcpStatuses = new Map<string, McpServerStatusInfo>();
  /** Status that arrived before `thread/start` named the thread. */
  const earlyStatus: Array<Record<string, unknown>> = [];
  const emitMcpStatus = (): void => {
    const callbacks = activeTurn?.callbacks;
    if (!callbacks?.onMcpStatus || mcpStatuses.size === 0) return;
    const snapshot = [...mcpStatuses.values()].map((status) => ({ ...status }));
    safeCallback(() => callbacks.onMcpStatus?.(snapshot));
  };
  const applyMcpStatus = (params: Record<string, unknown>): boolean => {
    const tagged = text(params.threadId);
    if (tagged && tagged !== threadId) return false;
    const status = codexMcpStatus(params);
    if (!status) return false;
    const previous = mcpStatuses.get(status.name);
    if (previous && JSON.stringify(previous) === JSON.stringify(status)) return false;
    mcpStatuses.set(status.name, status);
    return true;
  };
  // Both go in before `thread/start`: servers start, and can ask for input,
  // as soon as the thread opens.
  client.onNotification((method, rawParams) => {
    const params = record(rawParams);
    if (!params) return;
    if (method === "serverRequest/resolved") {
      if (params.threadId !== threadId) return;
      const requestId = params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        openElicitations.get(requestId)?.abort();
      }
      return;
    }
    if (method !== "mcpServer/startupStatus/updated") return;
    if (threadId === undefined) {
      earlyStatus.push(params);
      return;
    }
    if (applyMcpStatus(params)) emitMcpStatus();
  });
  client.onServerRequest(async (request) => {
    if (request.method !== "mcpServer/elicitation/request") {
      throw new UnsupportedServerRequestError(request.method);
    }
    const params = record(request.params);
    const turn = activeTurn;
    // A tool call an earlier turn left behind can still ask. Nobody is waiting
    // on it, and this turn's user would be answering something else.
    const stale = typeof params?.turnId === "string" && previousTurnIds.has(params.turnId);
    const elicitation = params && params.threadId === threadId && turn && !stale
      ? codexElicitationRequest(params)
      : undefined;
    if (!turn || !elicitation) return { action: "decline" };
    const resolved = new AbortController();
    openElicitations.set(request.id, resolved);
    try {
      return await answerMcpElicitation(turn.callbacks.onMcpElicitation, elicitation, [
        turn.elicitations.signal,
        resolved.signal,
      ]);
    } finally {
      openElicitations.delete(request.id);
    }
  });

  let opened: OpenedCodexThread;
  try {
    opened = openedCodexThread(
      await requestCodexThread(client, { ...options, threadSource: "user" }),
      options.model,
    );
  } catch (error) {
    client.close();
    throw error;
  }
  threadId = opened.threadId;
  for (const params of earlyStatus.splice(0)) applyMcpStatus(params);

  let closed = false;
  let running = false;
  let steerRunning: ((prompt: string) => Promise<void>) | null = null;
  let closePromise: Promise<void> | undefined;
  /** The app-server went on its own, before close asked it to. */
  let exited = false;
  /** A turn started on the thread: from then on Codex may have saved it. */
  let turnStarted = false;
  client.onClose(() => {
    if (!closed) exited = true;
    closed = true;
    activeTurn?.elicitations.abort();
  });
  /** Whether close archives the thread: asked to, once a turn started, as a
   * thread with none has no rollout to move. One whose `turn/start` went
   * unanswered may have one, so it counts too. */
  const archives = (): boolean => !!options.archive && turnStarted;
  const archiveThread = async (): Promise<void> => {
    const failed = (error: unknown) => safeCallback(() => options.onArchiveError?.(
      opened.threadId,
      error instanceof Error ? error : new Error(String(error)),
    ));
    if (exited) return failed(new Error("Codex app-server exited before the thread was archived"));
    try {
      await client.request("thread/archive", { threadId: opened.threadId }, options.archiveTimeoutMs ?? ARCHIVE_TIMEOUT_MS);
    } catch (error) {
      failed(error);
    }
  };

  const run = async (
    turnOptions: CodexAppServerTurnOptions,
    start: "turn" | "compact",
  ): Promise<RunResult> => {
    if (closed) throw new Error("Codex app-server session is closed");
    if (running) throw new Error("Codex app-server session already has an active turn");
    running = true;
    const turn = { callbacks: turnOptions, elicitations: new AbortController() };
    activeTurn = turn;
    emitMcpStatus();
    try {
      return await runCodexAppServerTurn({
        ...turnOptions,
        cwd: options.cwd,
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
        ...(options.dangerouslyBypassApprovalsAndSandbox !== undefined
          ? {
              dangerouslyBypassApprovalsAndSandbox:
                options.dangerouslyBypassApprovalsAndSandbox,
            }
          : {}),
        ...(options.developerInstructions
          ? { developerInstructions: options.developerInstructions }
          : {}),
      }, {
        client,
        thread: opened,
        ownsClient: false,
        retireClientOnUnackedStart: true,
        start,
        continuity: {
          previousTurnIds,
          onTurnId: (turnId) => {
            previousTurnIds.add(turnId);
          },
          onTurnStartSent: () => {
            turnStarted = true;
          },
          // A compaction takes no more input.
          ...(start === "turn"
            ? {
                onSteerable: (steer: ((prompt: string) => Promise<void>) | null) => {
                  steerRunning = steer;
                },
              }
            : {}),
        },
      });
    } finally {
      running = false;
      steerRunning = null;
      activeTurn = undefined;
      turn.elicitations.abort();
    }
  };

  return {
    threadId: opened.threadId,
    cwd: options.cwd,
    get closed() {
      return closed;
    },
    runTurn(turnOptions) {
      return run(turnOptions, "turn");
    },
    compact(compactOptions) {
      return run({ ...compactOptions, prompt: "" }, "compact");
    },
    async steer({ prompt }) {
      if (closed) throw new SteerRejectedError("Codex app-server session is closed");
      if (!steerRunning) throw new SteerRejectedError("Codex app-server session has no active turn");
      return steerRunning(prompt);
    },
    onClose(handler) {
      return client.onClose(handler);
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      // closed before anything awaits: a turn or steer from here is refused
      closed = true;
      const exit = () => {
        client.close();
        return whenExited;
      };
      // the archive starts once closePromise is set, so a callback that closes again gets this close;
      // with nothing to archive, the app-server is told to go at once
      closePromise = archives() ? Promise.resolve().then(archiveThread).then(exit) : exit();
      return closePromise;
    },
  };
}

export async function runCodexAppServer(opts: RunCodexOptions): Promise<RunResult> {
  if (opts.signal?.aborted) throw new AbortError("codex run aborted");
  const ownedClient = !opts.appServerClient;
  const client = opts.appServerClient ?? await createCodexAppServerClient({
    cwd: opts.cwd,
    ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
  });
  return runCodexAppServerTurn(opts, {
    client,
    ownsClient: ownedClient,
    retireClientOnUnackedStart: ownedClient,
    start: "turn",
  });
}
