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
/** One selectable answer supplied by a provider-native question tool. */
interface UserInputOption {
    label: string;
    /** Explanatory copy shown next to the label when the provider supplies it. */
    description?: string;
}
/** One provider-native question normalized for a host UI. */
interface UserInputQuestion {
    id: string;
    header: string;
    question: string;
    options: UserInputOption[];
    multiSelect: boolean;
    allowOther: boolean;
    secret: boolean;
}
/** A question-tool invocation that pauses the current provider turn. */
interface UserInputRequest {
    requestId: string;
    questions: UserInputQuestion[];
    autoResolutionMs?: number;
}
/** Answers keyed by normalized question id. */
interface UserInputResponse {
    answers: Record<string, string[]>;
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
    /** Fired when the provider pauses the current turn for structured user input. */
    onUserInputRequest?: (request: UserInputRequest) => Promise<UserInputResponse>;
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
/** The Claude Code CLI's --permission-mode choices. Like the system prompt,
 * the mode is rebuilt from flags on each run, so it must be supplied on
 * resumed turns too — a session does not remember it. */
type ClaudePermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan";
interface RunClaudeOptions extends CommonRunOptions {
    /** Text passed via --append-system-prompt. The CLI rebuilds the system
     * prompt from flags on each run, so this must be supplied on resumed turns
     * too, not just the first spawn. */
    appendSystemPrompt?: string;
    /** Permission mode passed via --permission-mode. `plan` keeps the turn
     * read-only on the project while research tools still run. */
    permissionMode?: ClaudePermissionMode;
    /** Tool names passed via --disallowed-tools. Headless plan turns disallow
     * ExitPlanMode: the CLI never enables it under -p, and suppressing it stops
     * the model from hunting for an approval channel that doesn't exist. */
    disallowedTools?: string[];
    /** Built-in tool whitelist passed via --tools as one comma-joined argument
     * (the CLI's documented "Bash,Edit,Read" form; the flag is variadic, so
     * separate arguments would swallow whatever followed). Unlike
     * disallowedTools, an explicit empty array is emitted as --tools "" — the
     * CLI's disable-all form — rather than omitted, so an empty whitelist can
     * never silently widen back to the full set. MCP tools are outside this
     * flag's scope; gate those with permission settings instead. */
    tools?: string[];
    /** Settings sources the CLI may load ("user", "project", "local"), passed
     * via --setting-sources as one comma-joined argument. Omitting a source
     * drops its permission rules for the turn — e.g. excluding "user" keeps a
     * broad `permissions.allow` in ~/.claude/settings.json from pre-approving
     * what the turn's permission mode would otherwise gate. */
    settingSources?: Array<"user" | "project" | "local">;
    /** Extra session settings passed verbatim via --settings: a JSON string or
     * a file path, per the CLI. Merged on top of the loaded setting sources. */
    settings?: string;
    /** Pre-assign a UUID for the new session (turn 1). Mutually exclusive with resumeSessionId. */
    newSessionId?: string;
    /** Resume an existing session by id (turn 2+). Mutually exclusive with newSessionId. */
    resumeSessionId?: string;
    /** Run a non-persistent one-shot request with customizations, tools, and MCP
     * disabled. Intended for small metadata tasks such as chat titles. */
    isolated?: boolean;
}
/** Run one logical Claude turn. Native questions may stop and resume several
 * `claude -p` processes, but hosts see one callback stream and one result. */
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
    /** Register a handler for one server-initiated RPC method. Returning
     * undefined leaves the request available to another handler (used when one
     * client multiplexes several threads). */
    onServerRequest(method: string, handler: CodexServerRequestHandler): () => void;
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
/** A per-turn sandbox override, mirroring app-server's SandboxPolicy union.
 * `turn/start` documents it as applying "for this turn and subsequent turns",
 * so hosts that flip it (e.g. a read-only plan turn) must send an explicit
 * policy on every turn rather than relying on the thread's starting value. */
type CodexSandboxPolicy = {
    type: "dangerFullAccess";
} | {
    type: "readOnly";
    networkAccess?: boolean;
} | {
    type: "workspaceWrite";
    networkAccess?: boolean;
    writableRoots?: string[];
    excludeSlashTmp?: boolean;
    excludeTmpdirEnvVar?: boolean;
} | {
    type: "externalSandbox";
    networkAccess?: "restricted" | "enabled";
};
interface RunCodexOptions extends CommonRunOptions {
    /** Preserve the historical full-host-access behavior for trusted callers. */
    dangerouslyBypassApprovalsAndSandbox?: boolean;
    /** Sandbox override passed directly to app-server's `turn/start`. Sticky
     * across turns on the same thread — see {@link CodexSandboxPolicy}. */
    sandboxPolicy?: CodexSandboxPolicy;
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
    /** Service tier passed directly to app-server's `turn/start`.
     * Null explicitly clears a tier retained by the thread. */
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

export { AbortError, type AgentCallbacks, type BackgroundAgentInfo, type BackgroundAgentProgress, type BackgroundAgentStatus, CLAUDE_STRIPPED_ENV_VARS, CODEX_STRIPPED_ENV_VARS, type ClaudePermissionMode, type CodexAppServerClient, type CodexAppServerSession, type CodexAppServerTurnOptions, type CodexSandboxPolicy, type CodexServerRequest, type CodexServerRequestHandler, CodexTurnError, type CommonRunOptions, type CreateCodexAppServerClientOptions, type CreateCodexAppServerSessionOptions, KNOWN_CONTEXT_WINDOWS, MissingCliError, type RunClaudeOptions, type RunCodexOptions, type RunResult, type SpawnFn, TimeoutError, type TokenUsage, type ToolPlanItem, type ToolResultInfo, type ToolUseInfo, type UserInputOption, type UserInputQuestion, type UserInputRequest, type UserInputResponse, contextWindowForModel, createCodexAppServerClient, createCodexAppServerSession, runClaude, runCodex };
