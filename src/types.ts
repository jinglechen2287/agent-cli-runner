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
  /** Provider-reported id that ties this invocation to its eventual result. */
  callId?: string;
  /** Provider-normalized tool name (e.g. "Edit", "Bash", or an MCP tool id). */
  name: string;
  /** One-line, human-readable summary of what the tool acted on — a file
   * path, shell command, search pattern, URL, or query. Omitted when the CLI
   * reported nothing meaningful to summarize. */
  summary?: string;
  /** Best-effort raw tool input as reported by the CLI (the Claude tool_use
   * `input`, or the Codex stream item), when available. */
  input?: Record<string, unknown>;
  /** Provider-normalized Codex plan/todo snapshot, when this tool updates one. */
  planItems?: ToolPlanItem[];
}

/** A completed tool result as reported by the provider. Hosts should treat
 * `content` as opaque unless they recognize the corresponding tool. */
export interface ToolResultInfo {
  /** Matches {@link ToolUseInfo.callId}. */
  callId: string;
  content: unknown;
  isError?: boolean;
}

/** One provider-normalized item from a Codex plan/todo snapshot. */
export interface ToolPlanItem {
  text: string;
  status: string;
}

/** Provider-normalized state of a background subagent. Each callback carries
 * a complete snapshot and supersedes the prior snapshot with the same `id`. */
export type BackgroundAgentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export interface BackgroundAgentProgress {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  lastToolName?: string;
}

export interface BackgroundAgentInfo {
  /** Claude task id or Codex child thread id. Stable within the parent turn. */
  id: string;
  provider: "claude" | "codex";
  /** Tool invocation that originally spawned the agent, when reported. */
  parentToolCallId?: string;
  description?: string;
  agentType?: string;
  status: BackgroundAgentStatus;
  summary?: string;
  error?: string;
  progress?: BackgroundAgentProgress;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
}

export interface AgentCallbacks {
  /** Fired once with the CLI's session/thread id as soon as it is known. */
  onSessionId?: (id: string) => void;
  /** Fired for each completed assistant message. */
  onAssistantText?: (text: string) => void;
  /** Fired with each fragment of assistant prose as the model produces it,
   * before the completed message arrives via {@link onAssistantText}. Supplying
   * it opts the run into partial-message streaming, which roughly doubles the
   * CLI's output volume — omit it for metadata runs that only need the result.
   *
   * Fragments cover assistant prose only: extended thinking, streamed tool
   * input, and background-subagent output are excluded. Concatenating every
   * fragment between two `onAssistantText` calls reproduces the later message,
   * so hosts should treat a fragment as scratch state that the completed
   * message supersedes, never as transcript content in its own right. */
  onAssistantTextDelta?: (delta: string) => void;
  /** Fired when the agent invokes a tool (deduplicated per tool invocation). */
  onToolUse?: (info: ToolUseInfo) => void;
  /** Fired when the provider reports the result for a tool invocation. */
  onToolResult?: (info: ToolResultInfo) => void;
  /** Fired whenever a background subagent starts, progresses, or finishes.
   * Repeated calls with the same id are replace-in-place snapshots. */
  onBackgroundAgentUpdate?: (info: BackgroundAgentInfo) => void;
  /** Raw stderr chunks from the CLI process. */
  onStderr?: (chunk: string) => void;
  /** Fired with a normalized context-usage snapshot whenever the CLI reports
   * token counts. Claude fires it per assistant message (live) and once more
   * at the end with the authoritative window merged into the last snapshot;
   * Codex fires it once after completion using app-server's authoritative last
   * request and model context window. Each call supersedes the last. */
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
