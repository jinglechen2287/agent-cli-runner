import { spawn } from "node:child_process";
import { CodexTurnError, MissingCliError } from "./errors.js";
import { runCodexAppServer, type CodexAppServerSession } from "./codex-app-server.js";
import type { CodexAppServerClient, CodexConfigOverrides } from "./codex-client.js";
import { codexTokenUsage, summarizeTool, toolInput, toolName } from "./codex-items.js";
import {
  createDeferred,
  isRecord,
  normalizeSummary,
  planCompletionSummary,
  planItem,
  safeCallback,
  toPlanItems,
  toTokenCount,
} from "./internal.js";
import {
  childEnv,
  createChunkDecoder,
  createLineSplitter,
  isMissingExecutable,
  signalProcessTree,
  spawnCli,
  terminateTree,
  watchLifecycle,
  writePrompt,
} from "./process.js";
import type { CommonRunOptions, RunResult, ToolPlanItem } from "./types.js";
import { contextWindowForModel, type TokenUsage } from "./usage.js";

/** A per-turn sandbox override, mirroring app-server's SandboxPolicy union.
 * `turn/start` documents it as applying "for this turn and subsequent turns",
 * so hosts that flip it (e.g. a read-only plan turn) must send an explicit
 * policy on every turn rather than relying on the thread's starting value. */
export type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess?: boolean }
  | {
      type: "workspaceWrite";
      networkAccess?: boolean;
      writableRoots?: string[];
      excludeSlashTmp?: boolean;
      excludeTmpdirEnvVar?: boolean;
    }
  | { type: "externalSandbox"; networkAccess?: "restricted" | "enabled" };

export interface RunCodexOptions extends CommonRunOptions {
  /** Preserve the historical full-host-access behavior for trusted callers. */
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  /** Sandbox override passed directly to app-server's `turn/start`. Sticky
   * across turns on the same thread — see {@link CodexSandboxPolicy}. */
  sandboxPolicy?: CodexSandboxPolicy;
  /** Working directory for this turn alone, sent as `turn/start`'s `cwd`.
   * That override is sticky too, so every turn sends `turnCwd ?? cwd` and a
   * turn without one returns the thread to `cwd`. App-server runs only. */
  turnCwd?: string;
  /** Text applied as developer instructions for the thread. */
  developerInstructions?: string;
  /** Resume an existing app-server thread by id. */
  resumeSessionId?: string;
  /** Images supplied as app-server local-image inputs. */
  imagePaths?: string[];
  /** Model used for the turn and usage attribution. */
  model?: string;
  /** Explicit context-window fallback when app-server omits one. */
  contextWindow?: number;
  /** Reasoning effort passed directly to app-server's `turn/start`, or as
   * the `model_reasoning_effort` config override on isolated `codex exec`. */
  reasoningEffort?: string;
  /** Service tier passed directly to app-server's `turn/start`.
   * Null explicitly clears a tier retained by the thread. Rejected on
   * isolated runs — `codex exec` has no equivalent. */
  serviceTier?: string | null;
  /** Reuse an initialized app-server connection. When omitted, regular runs
   * create and close a connection for this turn. */
  appServerClient?: CodexAppServerClient;
  /** Reuse an app-server process with one thread already started or resumed. */
  appServerSession?: CodexAppServerSession;
  /** Run a non-persistent one-shot request without user config or rules.
   * Codex app-server cannot currently reproduce both ignore flags per thread,
   * so this narrow metadata path intentionally remains on `codex exec`. */
  isolated?: boolean;
  /** Fork this existing app-server thread for a side run, on a one-off
   * app-server: an ephemeral copy that sees the thread's history and writes
   * nothing back. With `isolated`, its tools and MCP servers are turned off
   * (see {@link CODEX_FORK_CONFIG}) and one it starts anyway interrupts the
   * run, which rejects. Without, it keeps Codex's tools under the caller's
   * `sandboxPolicy`. */
  forkSessionId?: string;
  /** Config overrides for a guarded fork, sent on `thread/fork` — e.g.
   * `{ mcp_servers: { name: { url } } }`. Only a guarded fork takes them: an
   * isolated one's config is what keeps its tools off. */
  forkConfig?: CodexConfigOverrides;
}

interface CodexExecEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: unknown;
  item?: Record<string, unknown>;
  usage?: unknown;
}

function buildIsolatedArgs(opts: RunCodexOptions): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
  ];
  if (opts.model !== undefined) args.push("--model", opts.model);
  if (opts.developerInstructions !== undefined) {
    args.push("-c", `developer_instructions=${JSON.stringify(opts.developerInstructions)}`);
  }
  if (opts.reasoningEffort !== undefined) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(opts.reasoningEffort)}`);
  }
  for (const path of opts.imagePaths ?? []) args.push("-i", path);
  args.push("-");
  return args;
}

/** Plan/todo items are the one item family `codex exec` reports that the
 * app-server expresses as a separate notification instead, so only this
 * mapping stays exec-local; everything else defers to the shared normalizer
 * in codex-items.ts so the two paths cannot drift. */
function isExecPlanItem(item: Record<string, unknown>): boolean {
  return item.type === "todo_list" || item.type === "plan_update";
}

function execToolName(item: Record<string, unknown>): string | null {
  return isExecPlanItem(item) ? "TodoWrite" : toolName(item);
}

function execPlanItems(item: Record<string, unknown>): ToolPlanItem[] | undefined {
  return toPlanItems(Array.isArray(item.items) ? item.items : item.plan, (entry) => planItem(
    normalizeSummary(entry.text) ?? normalizeSummary(entry.step),
    typeof entry.completed === "boolean"
      ? entry.completed ? "completed" : "pending"
      : entry.status,
  ));
}

function execToolSummary(
  item: Record<string, unknown>,
  planItems: ToolPlanItem[] | undefined,
): string | undefined {
  if (isExecPlanItem(item) && planItems) return planCompletionSummary(planItems);
  return summarizeTool(item);
}

/** Normalize the `turn.completed` usage summary from `codex exec`. The counts
 * are cumulative for the turn, so — like Claude's `result` usage — they double
 * as a context-occupancy snapshot only for the single-request turns this
 * isolated metadata path is built for. `input_tokens` includes the cached
 * subset, matching app-server's convention. */
function execUsage(
  usage: Record<string, unknown>,
  opts: RunCodexOptions,
): TokenUsage | undefined {
  const input = toTokenCount(usage.input_tokens);
  const cached = toTokenCount(usage.cached_input_tokens);
  const output = toTokenCount(usage.output_tokens);
  if (input + output <= 0) return undefined;
  return codexTokenUsage(
    // Input side only (cached included), per the TokenUsage contract — not
    // app-server's totalTokens, which also counts output.
    { contextTokens: input, input, cached, output },
    opts.model,
    opts.contextWindow ?? contextWindowForModel(opts.model),
  );
}

/** The message an `error` or `turn.failed` event carries, wherever it put it. */
function errorDetail(event: CodexExecEvent): string | undefined {
  if (typeof event.message === "string") return event.message;
  if (typeof event.error === "string") return event.error;
  if (isRecord(event.error) && typeof event.error.message === "string") return event.error.message;
  return undefined;
}

function execFatalError(event: CodexExecEvent): CodexTurnError | undefined {
  if (event.type !== "error" && event.type !== "turn.failed") return undefined;
  const detail = errorDetail(event);
  return new CodexTurnError(detail ? `Codex error: ${detail}` : "Codex error");
}

async function runIsolatedCodex(opts: RunCodexOptions): Promise<RunResult> {
  const child = spawnCli({
    cli: "codex",
    spawnFn: opts.spawnFn ?? spawn,
    command: opts.executablePath ?? "codex",
    args: buildIsolatedArgs(opts),
    cwd: opts.cwd,
    env: childEnv("codex", opts.env ?? process.env),
  });

  return new Promise<RunResult>((resolve, reject) => {
    let settled = false;
    let sessionId: string | undefined;
    let finalText = "";
    let latestUsage: TokenUsage | undefined;
    let fatalError: CodexTurnError | undefined;
    const emittedTools = new Set<string>();
    /** The child closed or failed: no escalation is owed after that. */
    const ended = createDeferred();
    const lifecycle = watchLifecycle({
      cli: "codex",
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      terminate: () => void terminateTree((signal) => signalProcessTree(child, signal), ended),
    });

    const handleLine = (line: string): void => {
      let event: CodexExecEvent;
      try {
        event = JSON.parse(line) as CodexExecEvent;
      } catch {
        return;
      }
      fatalError ??= execFatalError(event);
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        const threadId = event.thread_id;
        sessionId = threadId;
        safeCallback(() => opts.onSessionId?.(threadId));
        return;
      }
      if (
        event.type === "item.completed"
        && event.item?.type === "agent_message"
        && typeof event.item.text === "string"
      ) {
        const message = event.item.text;
        finalText = message;
        safeCallback(() => opts.onAssistantText?.(message));
        return;
      }
      if (event.type === "turn.completed") {
        // The turn finished despite any earlier `error` event, so that error
        // was transient (e.g. a retried stream drop), not the run's outcome.
        fatalError = undefined;
        const usage = isRecord(event.usage) ? execUsage(event.usage, opts) : undefined;
        if (usage) {
          latestUsage = usage;
          safeCallback(() => opts.onUsage?.(usage));
        }
        return;
      }
      if (event.type !== "item.started" && event.type !== "item.completed") return;
      const item = event.item;
      if (!item) return;
      const name = execToolName(item);
      if (!name) return;
      const id = typeof item.id === "string" ? item.id : `${String(item.type)}:${name}`;
      if (!emittedTools.has(id)) {
        emittedTools.add(id);
        const planItems = execPlanItems(item);
        const summary = execToolSummary(item, planItems);
        safeCallback(() => opts.onToolUse?.({
          callId: id,
          name,
          ...(summary ? { summary } : {}),
          ...(planItems ? { planItems } : {}),
          input: toolInput(item),
        }));
      }
      if (event.type === "item.completed") {
        safeCallback(() => opts.onToolResult?.({ callId: id, content: item }));
      }
    };

    const splitter = createLineSplitter(handleLine);
    child.stdout?.on("data", (chunk: Buffer | string) => splitter.push(chunk));
    const stderrDecoder = createChunkDecoder((text) =>
      safeCallback(() => opts.onStderr?.(text)),
    );
    child.stderr?.on("data", (chunk: Buffer | string) => stderrDecoder.push(chunk));
    child.on("error", (error: Error) => {
      ended.resolve();
      if (settled) return;
      settled = true;
      lifecycle.cleanup();
      reject(isMissingExecutable(error) ? new MissingCliError("codex") : error);
    });
    child.on("close", (code) => {
      ended.resolve();
      if (settled) return;
      settled = true;
      splitter.flush();
      stderrDecoder.flush();
      lifecycle.cleanup();
      const interruption = lifecycle.interruptionError();
      if (interruption) {
        reject(interruption);
        return;
      }
      if (fatalError) {
        fatalError.exitCode = code ?? -1;
        reject(fatalError);
        return;
      }
      resolve({
        text: finalText.trim(),
        exitCode: code ?? -1,
        ...(sessionId ? { sessionId } : {}),
        ...(latestUsage ? { usage: latestUsage } : {}),
      });
    });
    writePrompt(child, opts.prompt);
  });
}

/** Run a Codex turn. Regular work uses app-server; only isolated metadata
 * requests retain the legacy non-interactive `codex exec` path. */
export async function runCodex(opts: RunCodexOptions): Promise<RunResult> {
  if (opts.forkConfig && (!opts.forkSessionId || opts.isolated)) {
    throw new Error("only a guarded fork can take fork config");
  }
  if (opts.forkSessionId) {
    validateForkedRun(opts);
    return runCodexAppServer(opts);
  }
  if (opts.isolated) {
    validateIsolatedRun(opts);
    return runIsolatedCodex(opts);
  }
  validateAppServerRun(opts);
  return opts.appServerSession ? opts.appServerSession.runTurn(opts) : runCodexAppServer(opts);
}

function validateAppServerRun(opts: RunCodexOptions): void {
  if (opts.appServerClient && opts.appServerSession) {
    throw new Error("Codex runs cannot use both appServerClient and appServerSession");
  }
  if (!opts.appServerSession) return;
  if (opts.resumeSessionId) {
    throw new Error("Session-backed Codex runs cannot resume another session");
  }
  if (
    opts.developerInstructions !== undefined
    || opts.dangerouslyBypassApprovalsAndSandbox !== undefined
    || opts.env !== undefined
    || opts.executablePath !== undefined
    || opts.spawnFn !== undefined
  ) {
    throw new Error("Session-backed Codex runs cannot override thread or client options");
  }
  if (opts.cwd !== opts.appServerSession.cwd) {
    throw new Error("Codex run cwd must match the app-server session cwd");
  }
}

function validateIsolatedRun(opts: RunCodexOptions): void {
  if (opts.appServerSession || opts.appServerClient) {
    throw new Error("isolated Codex runs cannot reuse app-server state");
  }
  if (opts.resumeSessionId) throw new Error("isolated Codex runs cannot resume a session");
  if (opts.dangerouslyBypassApprovalsAndSandbox) {
    throw new Error("isolated Codex runs cannot bypass approvals and sandboxing");
  }
  if (opts.sandboxPolicy) {
    throw new Error("isolated Codex runs cannot override the sandbox policy");
  }
  if (opts.turnCwd !== undefined) {
    throw new Error("isolated Codex runs cannot set a turn cwd");
  }
  if (opts.serviceTier !== undefined) {
    throw new Error("isolated Codex runs cannot set a service tier — codex exec has no equivalent");
  }
}

function validateForkedRun(opts: RunCodexOptions): void {
  if (opts.appServerSession || opts.appServerClient) {
    throw new Error("forked Codex runs cannot reuse app-server state");
  }
  if (opts.resumeSessionId) {
    throw new Error("forkSessionId and resumeSessionId are mutually exclusive");
  }
  if (opts.dangerouslyBypassApprovalsAndSandbox) {
    throw new Error("forked Codex runs cannot bypass approvals and sandboxing");
  }
  // A guarded fork may tune its read-only sandbox (network, say) but never
  // widen it. An isolated one keeps the read-only thread it forked into.
  if (opts.isolated && opts.sandboxPolicy) {
    throw new Error("forked Codex runs cannot override the sandbox policy");
  }
  if (opts.sandboxPolicy && opts.sandboxPolicy.type !== "readOnly") {
    throw new Error("forked Codex runs keep a read-only sandbox");
  }
  if (opts.turnCwd !== undefined) {
    throw new Error("forked Codex runs cannot set a turn cwd");
  }
}
