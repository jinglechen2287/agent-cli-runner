import { SpawnOptions, ChildProcess } from 'node:child_process';

/** Injectable spawn primitive so hosts and tests can substitute their own. */
type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
interface AgentCallbacks {
    /** Fired once with the CLI's session/thread id as soon as it is known. */
    onSessionId?: (id: string) => void;
    /** Fired for each completed assistant message. */
    onAssistantText?: (text: string) => void;
    /** Fired when the agent invokes a tool (deduplicated per tool invocation). */
    onToolUse?: (info: {
        name: string;
    }) => void;
    /** Raw stderr chunks from the CLI process. */
    onStderr?: (chunk: string) => void;
}
interface CommonRunOptions extends AgentCallbacks {
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
interface RunResult {
    /** Final assistant text of the turn ("" when the CLI produced none). */
    text: string;
    exitCode: number;
    /** Claude session id / Codex thread id, when the CLI reported one. */
    sessionId?: string;
}

/** Nesting-guard variables the Claude CLI uses to refuse running inside
 * another Claude Code session. Stripped so hosts launched by Claude Code
 * (or exposing it, like a bot) can still spawn turns. */
declare const CLAUDE_STRIPPED_ENV_VARS: readonly ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ACCESS_TOKEN"];
interface RunClaudeOptions extends CommonRunOptions {
    /** Text passed via --append-system-prompt. The CLI rebuilds the system
     * prompt from flags on each run, so this must be supplied on resumed turns
     * too, not just the first spawn. */
    appendSystemPrompt?: string;
    /** Pre-assign a UUID for the new session (turn 1). Mutually exclusive with resumeSessionId. */
    newSessionId?: string;
    /** Resume an existing session by id (turn 2+). Mutually exclusive with newSessionId. */
    resumeSessionId?: string;
}
/** Spawn a non-interactive Claude Code CLI turn (`claude -p` with stream-json
 * output) and translate its JSONL stream into callbacks plus a final result. */
declare function runClaude(opts: RunClaudeOptions): Promise<RunResult>;

/** Stripped so a Codex turn spawned from within another Codex session does
 * not inherit the parent's thread. */
declare const CODEX_STRIPPED_ENV_VARS: readonly ["CODEX_THREAD_ID"];
interface RunCodexOptions extends CommonRunOptions {
    /** Pass `--dangerously-bypass-approvals-and-sandbox` so Codex runs with
     * full host access and no approval prompts. Off by default — only enable
     * this for trusted prompts in environments you accept it can modify. */
    dangerouslyBypassApprovalsAndSandbox?: boolean;
    /** Text passed via `-c developer_instructions=...` on every turn. */
    developerInstructions?: string;
    /** Resume an existing thread by id (turn 2+). */
    resumeSessionId?: string;
    /** Image paths passed via repeated `-i` flags. */
    imagePaths?: string[];
}
/** Spawn a non-interactive Codex CLI turn (`codex exec --json`) and translate
 * its JSONL stream into the same callbacks used by the Claude runner. */
declare function runCodex(opts: RunCodexOptions): Promise<RunResult>;

declare class AbortError extends Error {
    readonly name = "AbortError";
    constructor(message?: string);
}
declare class TimeoutError extends Error {
    readonly name = "TimeoutError";
    constructor(message?: string);
}
declare class MissingCliError extends Error {
    readonly name = "MissingCliError";
    readonly cli: string;
    constructor(cli: string);
}
/** A fatal `error` / `turn.failed` event in the Codex JSONL stream. */
declare class CodexTurnError extends Error {
    readonly name = "CodexTurnError";
    /** Exit code of the Codex process, once known. */
    exitCode?: number;
}

export { AbortError, type AgentCallbacks, CLAUDE_STRIPPED_ENV_VARS, CODEX_STRIPPED_ENV_VARS, CodexTurnError, type CommonRunOptions, MissingCliError, type RunClaudeOptions, type RunCodexOptions, type RunResult, type SpawnFn, TimeoutError, runClaude, runCodex };
