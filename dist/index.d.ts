import { SpawnOptions, ChildProcess } from 'node:child_process';

/**
 * Provider-normalized token accounting, so a host can render one context-usage
 * meter for both Claude and Codex without knowing either CLI's raw shape.
 */
/**
 * Normalized token counts for the turn. `contextTokens` comes from the latest
 * provider request rather than cumulative turn totals, so it can drive a
 * current context-window meter for both Claude and Codex.
 */
interface TokenUsage {
    /**
     * Tokens occupying the model's context window: fresh input plus cached
     * input. The headline "how full is the context" number.
     */
    contextTokens: number;
    /** Fresh (non-cached) input tokens. */
    inputTokens: number;
    /** Input tokens served from cache (Claude cache reads; Codex cached input). */
    cachedInputTokens: number;
    /**
     * Provider-reported output tokens. Codex includes its separately reported
     * reasoning-token subset in this count.
     */
    outputTokens: number;
    /**
     * Model that produced this usage, when the CLI reports it. Claude reports it
     * on every turn; Codex `exec` does not, so this is only present when the host
     * told the runner which model it launched.
     */
    model?: string;
    /**
     * The model's total context window in tokens, when known — reported by the
     * provider or resolved from the model id via {@link contextWindowForModel}.
     * Absent when neither source could supply it; render the raw token count
     * without a percentage in that case.
     */
    contextWindow?: number;
}
/**
 * Context-window sizes for models whose id doesn't follow a simple family rule.
 * Values are best-effort fallbacks for callers without a provider-reported
 * window; `runCodex` prefers app-server's authoritative effective window.
 * Anthropic models are handled by the family rules in
 * {@link contextWindowForModel} instead.
 */
declare const KNOWN_CONTEXT_WINDOWS: Readonly<Record<string, number>>;
/**
 * Best-effort context window (in tokens) for a model id, or `undefined` when it
 * can't be determined. Consults {@link KNOWN_CONTEXT_WINDOWS} first, then
 * falls back to family rules: Anthropic models get 200k (1M for the `[1m]`
 * beta variants), and Codex `gpt-5.6*` / other `gpt-5*` models get 372k / 272k.
 */
declare function contextWindowForModel(model: string | undefined): number | undefined;

/** Injectable spawn primitive so hosts and tests can substitute their own. */
type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
/** What the agent did when it invoked a tool. `name` is always present; the
 * richer fields are best-effort and provider-normalized. */
interface ToolUseInfo {
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
interface ToolResultInfo {
    /** Matches {@link ToolUseInfo.callId}. */
    callId: string;
    content: unknown;
    isError?: boolean;
}
/** One provider-normalized item from a Codex plan/todo snapshot. */
interface ToolPlanItem {
    text: string;
    status: string;
}
/** Provider-normalized state of a background subagent. Each callback carries
 * a complete snapshot and supersedes the prior snapshot with the same `id`. */
type BackgroundAgentStatus = "pending" | "running" | "completed" | "failed" | "interrupted";
interface BackgroundAgentProgress {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
    lastToolName?: string;
}
interface BackgroundAgentInfo {
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
interface AgentCallbacks {
    /** Fired once with the CLI's session/thread id as soon as it is known. */
    onSessionId?: (id: string) => void;
    /** Fired for each completed assistant message. */
    onAssistantText?: (text: string) => void;
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
    /** The latest context-usage snapshot of the turn, when the CLI reported any
     * token counts. Matches the final {@link AgentCallbacks.onUsage} value. */
    usage?: TokenUsage;
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
    /** Run a non-persistent one-shot request with customizations, tools, and MCP
     * disabled. Intended for small metadata tasks such as chat titles. */
    isolated?: boolean;
}
/** Spawn a non-interactive Claude Code CLI turn (`claude -p` with stream-json
 * output) and translate its JSONL stream into callbacks plus a final result. */
declare function runClaude(opts: RunClaudeOptions): Promise<RunResult>;

interface CodexServerRequest {
    id: number | string;
    method: string;
    params: unknown;
}
type CodexServerRequestHandler = (request: CodexServerRequest) => Promise<unknown> | unknown;
interface CodexAppServerClient {
    request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    notify(method: string, params?: unknown): void;
    onNotification(handler: (method: string, params: unknown) => void): () => void;
    onServerRequest(handler: CodexServerRequestHandler): () => void;
    onStderr(handler: (chunk: string) => void): () => void;
    onClose(handler: (error: Error) => void): () => void;
    close(): void;
}
interface CreateCodexAppServerClientOptions {
    executablePath?: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    spawnFn?: RunCodexOptions["spawnFn"];
    requestTimeoutMs?: number;
}
type CodexAppServerTurnOptions = Omit<RunCodexOptions, "appServerClient" | "appServerSession" | "cwd" | "dangerouslyBypassApprovalsAndSandbox" | "developerInstructions" | "env" | "executablePath" | "isolated" | "resumeSessionId" | "spawnFn">;
interface CodexAppServerSession {
    readonly threadId: string;
    readonly cwd: string;
    readonly closed: boolean;
    runTurn(options: CodexAppServerTurnOptions): Promise<RunResult>;
    onClose(handler: (error: Error) => void): () => void;
    close(): Promise<void>;
}
interface CreateCodexAppServerSessionOptions {
    cwd: string;
    executablePath?: string;
    env?: NodeJS.ProcessEnv;
    spawnFn?: RunCodexOptions["spawnFn"];
    requestTimeoutMs?: number;
    resumeSessionId?: string;
    model?: string;
    developerInstructions?: string;
    dangerouslyBypassApprovalsAndSandbox?: boolean;
}
declare function createCodexAppServerClient(options: CreateCodexAppServerClientOptions): Promise<CodexAppServerClient>;
declare function createCodexAppServerSession(options: CreateCodexAppServerSessionOptions): Promise<CodexAppServerSession>;

/** Stripped so a Codex turn spawned from within another Codex session does
 * not inherit the parent's thread. */
declare const CODEX_STRIPPED_ENV_VARS: readonly ["CODEX_THREAD_ID"];
interface RunCodexOptions extends CommonRunOptions {
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
/** Run a Codex turn. Regular work uses app-server; only isolated metadata
 * requests retain the legacy non-interactive `codex exec` path. */
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

export { AbortError, type AgentCallbacks, type BackgroundAgentInfo, type BackgroundAgentProgress, type BackgroundAgentStatus, CLAUDE_STRIPPED_ENV_VARS, CODEX_STRIPPED_ENV_VARS, type CodexAppServerClient, type CodexAppServerSession, type CodexAppServerTurnOptions, type CodexServerRequest, type CodexServerRequestHandler, CodexTurnError, type CommonRunOptions, type CreateCodexAppServerClientOptions, type CreateCodexAppServerSessionOptions, KNOWN_CONTEXT_WINDOWS, MissingCliError, type RunClaudeOptions, type RunCodexOptions, type RunResult, type SpawnFn, TimeoutError, type TokenUsage, type ToolPlanItem, type ToolResultInfo, type ToolUseInfo, contextWindowForModel, createCodexAppServerClient, createCodexAppServerSession, runClaude, runCodex };
