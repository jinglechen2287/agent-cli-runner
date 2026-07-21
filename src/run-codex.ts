import { spawn } from "node:child_process";
import { CodexTurnError, MissingCliError } from "./errors.js";
import {
  runCodexAppServer,
  type CodexAppServerClient,
  type CodexAppServerSession,
} from "./codex-app-server.js";
import {
  createLineSplitter,
  filterEnv,
  isMissingExecutable,
  normalizeSummary,
  signalProcessTree,
  watchLifecycle,
  writePrompt,
} from "./internal.js";
import type { CommonRunOptions, RunResult, ToolPlanItem } from "./types.js";

/** Stripped so a Codex turn spawned from within another Codex session does
 * not inherit the parent's thread. */
export const CODEX_STRIPPED_ENV_VARS = ["CODEX_THREAD_ID"] as const;

export interface RunCodexOptions extends CommonRunOptions {
  /** Preserve the historical full-host-access behavior for trusted callers. */
  dangerouslyBypassApprovalsAndSandbox?: boolean;
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
  /** Reasoning effort passed directly to app-server's `turn/start`. */
  reasoningEffort?: string;
  /** Reuse an initialized app-server connection. When omitted, regular runs
   * create and close a connection for this turn. */
  appServerClient?: CodexAppServerClient;
  /** Reuse an app-server process with one thread already started or resumed. */
  appServerSession?: CodexAppServerSession;
  /** Run a non-persistent one-shot request without user config or rules.
   * Codex app-server cannot currently reproduce both ignore flags per thread,
   * so this narrow metadata path intentionally remains on `codex exec`. */
  isolated?: boolean;
}

interface CodexExecEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: unknown;
  item?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  for (const path of opts.imagePaths ?? []) args.push("-i", path);
  args.push("-");
  return args;
}

function execToolName(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case "command_execution":
      return "Bash";
    case "file_change":
      return "Edit";
    case "mcp_tool_call":
      return typeof item.tool === "string" ? item.tool : "MCP";
    case "web_search":
      return "WebSearch";
    case "todo_list":
    case "plan_update":
      return "TodoWrite";
    default:
      return null;
  }
}

function execWebQuery(item: Record<string, unknown>): string | undefined {
  const direct = normalizeSummary(item.query);
  if (direct) return direct;
  if (!isRecord(item.action)) return undefined;
  const query = normalizeSummary(item.action.query);
  if (query) return query;
  if (!Array.isArray(item.action.queries)) return undefined;
  for (const candidate of item.action.queries) {
    const normalized = normalizeSummary(candidate);
    if (normalized) return normalized;
  }
  return undefined;
}

function execPlanItems(item: Record<string, unknown>): ToolPlanItem[] | undefined {
  const values = Array.isArray(item.items)
    ? item.items
    : Array.isArray(item.plan) ? item.plan : undefined;
  if (!values) return undefined;
  const items: ToolPlanItem[] = [];
  for (const value of values) {
    if (!isRecord(value)) return undefined;
    const text = normalizeSummary(value.text) ?? normalizeSummary(value.step);
    const rawStatus = typeof value.completed === "boolean"
      ? value.completed ? "completed" : "pending"
      : normalizeSummary(value.status);
    const status = rawStatus?.toLowerCase().replace(/\s+/g, "_");
    if (!text || !status) return undefined;
    items.push({ text, status });
  }
  return items.length > 0 ? items : undefined;
}

function execToolSummary(
  item: Record<string, unknown>,
  planItems: ToolPlanItem[] | undefined,
): string | undefined {
  if (item.type === "command_execution") return normalizeSummary(item.command);
  if (item.type === "web_search") return execWebQuery(item);
  if (item.type === "file_change" && Array.isArray(item.changes)) {
    const paths = item.changes.flatMap((change) => {
      const path = isRecord(change) ? normalizeSummary(change.path) : undefined;
      return path ? [path] : [];
    });
    if (paths.length === 1) return paths[0];
    if (paths.length > 1) return `${paths.length} files`;
  }
  if ((item.type === "todo_list" || item.type === "plan_update") && planItems) {
    const complete = planItems.filter(({ status }) => status === "completed").length;
    return `${complete}/${planItems.length} steps completed`;
  }
  return undefined;
}

function execFatalError(event: CodexExecEvent): CodexTurnError | undefined {
  if (event.type !== "error" && event.type !== "turn.failed") return undefined;
  const detail = typeof event.message === "string"
    ? event.message
    : typeof event.error === "string"
      ? event.error
      : isRecord(event.error) && typeof event.error.message === "string"
        ? event.error.message
        : undefined;
  return new CodexTurnError(detail ? `Codex error: ${detail}` : "Codex error");
}

async function runIsolatedCodex(opts: RunCodexOptions): Promise<RunResult> {
  const spawnFn = opts.spawnFn ?? spawn;
  let child;
  try {
    child = spawnFn(opts.executablePath ?? "codex", buildIsolatedArgs(opts), {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: filterEnv(opts.env ?? process.env, CODEX_STRIPPED_ENV_VARS),
      detached: process.platform !== "win32",
    });
  } catch (error) {
    if (error instanceof Error && isMissingExecutable(error)) throw new MissingCliError("codex");
    throw error;
  }

  return new Promise<RunResult>((resolve, reject) => {
    let settled = false;
    let sessionId: string | undefined;
    let finalText = "";
    let fatalError: CodexTurnError | undefined;
    const emittedTools = new Set<string>();
    const lifecycle = watchLifecycle({
      cli: "codex",
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      kill: (signal) => signalProcessTree(child, signal),
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
        sessionId = event.thread_id;
        opts.onSessionId?.(event.thread_id);
        return;
      }
      if (
        event.type === "item.completed"
        && event.item?.type === "agent_message"
        && typeof event.item.text === "string"
      ) {
        finalText = event.item.text;
        opts.onAssistantText?.(event.item.text);
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
        opts.onToolUse?.({
          callId: id,
          name,
          ...(summary ? { summary } : {}),
          ...(planItems ? { planItems } : {}),
          input: item.type === "web_search" ? { ...item, query: execWebQuery(item) } : item,
        });
      }
      if (event.type === "item.completed") {
        opts.onToolResult?.({ callId: id, content: item });
      }
    };

    const splitter = createLineSplitter(handleLine);
    child.stdout?.on("data", (chunk: Buffer | string) => splitter.push(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => opts.onStderr?.(chunk.toString()));
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      lifecycle.cleanup();
      reject(isMissingExecutable(error) ? new MissingCliError("codex") : error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      splitter.flush();
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
      });
    });
    writePrompt(child, opts.prompt);
  });
}

/** Run a Codex turn. Regular work uses app-server; only isolated metadata
 * requests retain the legacy non-interactive `codex exec` path. */
export async function runCodex(opts: RunCodexOptions): Promise<RunResult> {
  if (!opts.isolated) {
    if (opts.appServerClient && opts.appServerSession) {
      throw new Error("Codex runs cannot use both appServerClient and appServerSession");
    }
    if (opts.appServerSession) {
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
      return opts.appServerSession.runTurn(opts);
    }
    return runCodexAppServer(opts);
  }
  if (opts.appServerSession || opts.appServerClient) {
    throw new Error("isolated Codex runs cannot reuse app-server state");
  }
  if (opts.resumeSessionId) throw new Error("isolated Codex runs cannot resume a session");
  if (opts.dangerouslyBypassApprovalsAndSandbox) {
    throw new Error("isolated Codex runs cannot bypass approvals and sandboxing");
  }
  return runIsolatedCodex(opts);
}
