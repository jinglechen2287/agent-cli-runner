import type { ChildProcess, SpawnOptions } from "node:child_process";

/** Injectable spawn primitive so hosts and tests can substitute their own. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface AgentCallbacks {
  /** Fired once with the CLI's session/thread id as soon as it is known. */
  onSessionId?: (id: string) => void;
  /** Fired for each completed assistant message. */
  onAssistantText?: (text: string) => void;
  /** Fired when the agent invokes a tool (deduplicated per tool invocation). */
  onToolUse?: (info: { name: string }) => void;
  /** Raw stderr chunks from the CLI process. */
  onStderr?: (chunk: string) => void;
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
}
