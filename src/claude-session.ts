import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  query as sdkQuery,
  type EffortLevel,
  type HookCallbackMatcher,
  type HookEvent,
  type Options,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions as SdkSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { createClaudeTurnTranslator, type ClaudeTurnTranslator } from "./claude-messages.js";
import { AbortError, MissingCliError, TimeoutError } from "./errors.js";
import {
  createChunkDecoder,
  filterEnv,
  isRecord,
  resolveExecutable,
  safeCallback,
  SIGTERM_GRACE_MS,
  signalProcessTree,
} from "./internal.js";
import type { AgentCallbacks, RunResult, SpawnFn } from "./types.js";

/** Nesting-guard variables the Claude CLI uses to refuse running inside
 * another Claude Code session. Stripped so hosts launched by Claude Code
 * (or exposing it, like a bot) can still spawn turns. */
export const CLAUDE_STRIPPED_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
] as const;

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
  /** A non-persistent session with customizations, tools, and MCP disabled,
   * for small metadata tasks such as chat titles. */
  isolated?: boolean;
  /** Override {@link CLAUDE_INTERRUPT_GRACE_MS}. */
  interruptGraceMs?: number;
  /** Override {@link CLAUDE_FOLLOW_UP_GRACE_MS}. */
  followUpGraceMs?: number;
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

export interface ClaudeSession {
  /** The Claude session id: the pre-assigned or resumed id. */
  readonly sessionId: string;
  readonly cwd: string;
  readonly closed: boolean;
  /** Run one turn. Rejects when another turn is active or the session is closed. */
  runTurn(options: ClaudeSessionTurnOptions): Promise<RunResult>;
  /** Called once, with the reason, when the session closes for any reason. */
  onClose(handler: (error: Error) => void): () => void;
  /** Terminate the CLI process tree. Resolves once it has exited. */
  close(): Promise<void>;
}

interface ActiveTurn {
  translator: ClaudeTurnTranslator;
  callbacks: AgentCallbacks;
  interruption: "abort" | "timeout" | null;
  timeoutMs: number | undefined;
  /** Running while the turn waits on the CLI's follow-up `result`. */
  followUpTimer: ReturnType<typeof setTimeout> | undefined;
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
  if (opts.isolated && opts.resumeSessionId) {
    throw new Error("isolated Claude runs cannot resume a session");
  }
  if (opts.isolated && opts.permissionMode) {
    throw new Error("isolated Claude runs cannot set a permission mode");
  }
  if (opts.isolated && opts.tools) {
    throw new Error("isolated Claude runs cannot set tools — isolated already disables them all");
  }
}

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
    env: filterEnv(opts.env ?? process.env, CLAUDE_STRIPPED_ENV_VARS),
    pathToClaudeCodeExecutable: executablePath,
    spawnClaudeCodeProcess,
    ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : { sessionId }),
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
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    ...(opts.isolated
      ? { strictMcpConfig: true, persistSession: false, extraArgs: { "safe-mode": null } }
      : {}),
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
  const executablePath = resolveExecutable(opts.executablePath ?? "claude", env);
  if (!executablePath) throw new MissingCliError("claude");
  const sessionId = opts.resumeSessionId ?? opts.newSessionId ?? randomUUID();
  const spawnFn = opts.spawnFn ?? nodeSpawn;
  const queryFn: ClaudeQueryFn = opts.queryFn ?? sdkQuery;
  const interruptGraceMs = opts.interruptGraceMs ?? CLAUDE_INTERRUPT_GRACE_MS;
  const followUpGraceMs = opts.followUpGraceMs ?? CLAUDE_FOLLOW_UP_GRACE_MS;
  /** Some `result` of this process named its prompt, so one that names none
   * is never a turn's own. */
  let cliEchoesPromptUuid = false;

  let closed = false;
  let child: ChildProcess | undefined;
  let childExited = false;
  let active: ActiveTurn | undefined;
  let stderrTail = "";
  const closeHandlers = new Set<(error: Error) => void>();
  const exitWaiters = new Set<() => void>();
  const input = createInputQueue();

  const spawnClaudeCodeProcess = (spawnOptions: SdkSpawnOptions): SpawnedProcess => {
    const spawned = spawnFn(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd ?? opts.cwd,
      env: spawnOptions.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Process-group leader (POSIX), so killing the session reaches tool
      // children (a running Bash) as well as the CLI.
      detached: process.platform !== "win32",
    });
    child = spawned;
    spawned.once("exit", () => {
      childExited = true;
      for (const waiter of exitWaiters) waiter();
      exitWaiters.clear();
    });
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
    if (!spawned.stdin || !spawned.stdout) {
      throw new Error("Claude process was spawned without stdio pipes");
    }
    const stdin = spawned.stdin;
    const stdout = spawned.stdout;
    return {
      stdin,
      stdout,
      get killed() {
        return spawned.killed;
      },
      get exitCode() {
        return spawned.exitCode;
      },
      get signalCode() {
        return spawned.signalCode;
      },
      kill(signal) {
        signalProcessTree(spawned, signal);
        return true;
      },
      on: spawned.on.bind(spawned) as SpawnedProcess["on"],
      once: spawned.once.bind(spawned) as SpawnedProcess["once"],
      off: spawned.off.bind(spawned) as SpawnedProcess["off"],
    };
  };

  const options = claudeSessionQueryOptions(opts, sessionId, executablePath, spawnClaudeCodeProcess);
  const runtime = queryFn({ prompt: input.iterable, options });

  const killTree = (): Promise<void> => {
    const current = child;
    if (!current || childExited) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (killTimer) clearTimeout(killTimer);
        if (giveUpTimer) clearTimeout(giveUpTimer);
        exitWaiters.delete(done);
        resolve();
      };
      exitWaiters.add(done);
      signalProcessTree(current, "SIGTERM");
      killTimer = setTimeout(() => {
        signalProcessTree(current, "SIGKILL");
        // A process that ignores even SIGKILL (a zombie the OS has not reaped)
        // must not hang close() forever.
        giveUpTimer = setTimeout(done, SIGTERM_GRACE_MS);
        giveUpTimer.unref?.();
      }, SIGTERM_GRACE_MS);
      killTimer.unref?.();
    });
  };

  const interruptionError = (turn: ActiveTurn): Error =>
    turn.interruption === "timeout"
      ? new TimeoutError(`claude run timed out after ${turn.timeoutMs}ms`)
      : new AbortError("claude run aborted");

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

  const exitError = (cause?: unknown): Error => {
    const detail = cause instanceof Error ? cause.message : "Claude process exited";
    const tail = stderrTail.trim();
    return new Error(tail && !detail.includes(tail) ? `${detail}: ${tail}` : detail);
  };

  const settleTurn = (turn: ActiveTurn): void => {
    if (active !== turn) return;
    active = undefined;
    const outcome = turn.translator.finish();
    if (turn.interruption) {
      turn.reject(interruptionError(turn));
    } else {
      turn.resolve({
        text: outcome.text,
        exitCode: outcome.isError ? 1 : 0,
        ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
        ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
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
          turn.followUpTimer = setTimeout(() => settleTurn(turn), followUpGraceMs);
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

  return {
    sessionId,
    cwd: opts.cwd,
    get closed() {
      return closed;
    },
    runTurn(turnOptions: ClaudeSessionTurnOptions): Promise<RunResult> {
      // The close reason carries the CLI's stderr tail when it died on its
      // own, so a host that never subscribed to onClose still sees why.
      if (closed) return Promise.reject(closeReason ?? new Error("Claude session is closed"));
      if (active) return Promise.reject(new Error("Claude session already has an active turn"));
      const { prompt, signal, timeoutMs, ...callbacks } = turnOptions;
      if (signal?.aborted) return Promise.reject(new AbortError("claude run aborted"));

      return new Promise<RunResult>((resolve, reject) => {
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = (): void => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (graceTimer) clearTimeout(graceTimer);
          if (turn.followUpTimer) clearTimeout(turn.followUpTimer);
          signal?.removeEventListener("abort", onAbort);
        };
        // Stamped so the turn's result can be told apart from one the CLI
        // writes for something else — a task an earlier process left running.
        const promptUuid = randomUUID();
        const turn: ActiveTurn = {
          translator: createClaudeTurnTranslator(callbacks, { promptUuid, cliEchoesPromptUuid }),
          callbacks,
          interruption: null,
          timeoutMs,
          followUpTimer: undefined,
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
        input.push({
          type: "user",
          message: { role: "user", content: prompt },
          parent_tool_use_id: null,
          uuid: promptUuid,
        });
      });
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
