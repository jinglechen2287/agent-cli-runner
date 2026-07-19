import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { TokenUsage } from "./usage.js";

/** Injectable spawn primitive so hosts and tests can substitute their own. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** What the agent did when it invoked a tool. `name` is always present; the
 * richer fields are best-effort and provider-normalized. */
export interface ToolUseInfo {
  /** Provider-normalized tool name (e.g. "Edit", "Bash", or an MCP tool id). */
  name: string;
  /** One-line, human-readable summary of what the tool acted on — a file
   * path, shell command, search pattern, URL, or query. Omitted when the CLI
   * reported nothing meaningful to summarize. */
  summary?: string;
  /** Best-effort raw tool input as reported by the CLI (the Claude tool_use
   * `input`, or the Codex stream item), when available. */
  input?: Record<string, unknown>;
}

export interface AgentCallbacks {
  /** Fired once with the CLI's session/thread id as soon as it is known. */
  onSessionId?: (id: string) => void;
  /** Fired for each completed assistant message. */
  onAssistantText?: (text: string) => void;
  /** Fired when the agent invokes a tool (deduplicated per tool invocation). */
  onToolUse?: (info: ToolUseInfo) => void;
  /** Raw stderr chunks from the CLI process. */
  onStderr?: (chunk: string) => void;
  /** Fired with a normalized context-usage snapshot whenever the CLI reports
   * token counts. Claude fires it per assistant message (live) and once more
   * with authoritative window data at the end; Codex fires it once when the
   * turn completes. Each call supersedes the last. */
  onUsage?: (usage: TokenUsage) => void;
}

export interface CommonRunOptions extends AgentCallbacks {
  prompt: string;
  cwd: string;
  /** Path or name of the CLI binary. Defaults to the tool name on PATH. */
  executablePath?: string;
  /** Base environment for the child. Defaults to process.env. Nesting-guard
   * variables are stripped from it either way. */
  env?: NodeJS.ProcessEnv;
  /** When aborted, the child gets SIGTERM, then SIGKILL after a grace period,
   * and the returned promise rejects with an AbortError. */
  signal?: AbortSignal;
  /** Optional wall-clock limit. Uses the same kill path as abort and rejects
   * with a TimeoutError. No timeout when omitted. */
  timeoutMs?: number;
  spawnFn?: SpawnFn;
}

export interface RunResult {
  /** Final assistant text of the turn ("" when the CLI produced none). */
  text: string;
  exitCode: number;
  /** Claude session id / Codex thread id, when the CLI reported one. */
  sessionId?: string;
  /** The latest context-usage snapshot of the turn, when the CLI reported any
   * token counts. Matches the final {@link AgentCallbacks.onUsage} value. */
  usage?: TokenUsage;
}
