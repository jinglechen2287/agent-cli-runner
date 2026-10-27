import { HookEvent, HookCallbackMatcher, SDKUserMessage, Options } from '@anthropic-ai/claude-agent-sdk';
export { HookCallback as ClaudeHookCallback, HookCallbackMatcher as ClaudeHookCallbackMatcher, HookInput as ClaudeHookInput, HookJSONOutput as ClaudeHookOutput, PreToolUseHookInput as ClaudePreToolUseHookInput, PreToolUseHookSpecificOutput as ClaudePreToolUseHookOutput } from '@anthropic-ai/claude-agent-sdk';
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
 * falls back to family rules: Anthropic models get 200k (1M for the `[1m]` beta
 * variants and for the natively-1M Fable/Mythos family), and Codex `gpt-5.6*` /
 * other `gpt-5*` models get 372k / 272k.
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
    /** Fired for each completed assistant message of the parent turn.
     * Background-subagent prose is excluded — mirroring
     * {@link onAssistantTextDelta} — so a subagent's answer never masquerades
     * as the turn's transcript; its state streams through
     * {@link onBackgroundAgentUpdate} instead. */
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
     * regular Codex fires it once after completion using app-server's
     * authoritative last request and model context window, and isolated Codex
     * once from the exec turn summary. Each call supersedes the last. */
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
/** Claude Code permission modes. `manual` is this package's name for the
 * CLI's `default` (prompt-for-everything) mode. */
type ClaudePermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan";
/** In-process hook callbacks, keyed by hook event — the Agent SDK's shape. */
type ClaudeHooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>;
/** The slice of the Agent SDK's `Query` a session drives. */
interface ClaudeQuery extends AsyncIterable<unknown> {
    interrupt(): Promise<unknown>;
    close(): void;
}
/** The Agent SDK's `query()`, narrowed to the streaming-input form a session
 * uses. Injectable so tests can script the message stream. */
type ClaudeQueryFn = (params: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: Options;
}) => ClaudeQuery;
/** How long an interrupted turn may take to deliver its `result` before the
 * process is killed without waiting for it. */
declare const CLAUDE_INTERRUPT_GRACE_MS = 5000;
/** How long a turn held open for a subagent waits in silence, once every
 * subagent has settled, for the CLI to answer the notification with a
 * `result` before the turn settles without it. */
declare const CLAUDE_FOLLOW_UP_GRACE_MS = 60000;
interface CreateClaudeSessionOptions {
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
type ClaudeSessionTurnOptions = AgentCallbacks & {
    prompt: string;
    /** Aborting interrupts the turn, rejects with an AbortError, and closes the
     * session once the CLI has finished the interrupt (or after the grace
     * period); the next turn resumes from disk in a new session. */
    signal?: AbortSignal;
    /** Wall-clock limit for the turn, using the same interrupt path; rejects
     * with a TimeoutError. */
    timeoutMs?: number;
};
interface ClaudeSessionSteerOptions {
    /** More input for the running turn, as the user would type it mid-turn. */
    prompt: string;
}
interface ClaudeSession {
    /** The Claude session id: the pre-assigned or resumed id. */
    readonly sessionId: string;
    readonly cwd: string;
    readonly closed: boolean;
    /** Run one turn. Rejects when another turn is active or the session is closed. */
    runTurn(options: ClaudeSessionTurnOptions): Promise<RunResult>;
    /** Hand more input to the running turn. The CLI reads it at the turn's next
     * tool round, or answers it as a turn of its own right after — either way
     * the running turn settles only once it is answered. Rejects with a
     * {@link SteerRejectedError} when no turn is running or the turn is past
     * taking more: interrupted, or its result already in. */
    steer(options: ClaudeSessionSteerOptions): Promise<void>;
    /** Called once, with the reason, when the session closes for any reason. */
    onClose(handler: (error: Error) => void): () => void;
    /** Terminate the CLI process tree. Resolves once it has exited. */
    close(): Promise<void>;
}
/** Start a long-lived Claude Code session over the Agent SDK. Turns run one at
 * a time through {@link ClaudeSession.runTurn}; the CLI process stays up
 * between them. Startup failures surface on the first turn. */
declare function createClaudeSession(opts: CreateClaudeSessionOptions): Promise<ClaudeSession>;

interface RunClaudeOptions extends CommonRunOptions {
    /** Model: an alias for the latest of a family ("fable", "opus", "sonnet",
     * "haiku") or a full id ("claude-fable-5"). Omitted = the CLI's configured
     * default. */
    model?: string;
    /** Effort level ("low" | "medium" | "high" | "xhigh" | "max"). Omitted =
     * the CLI's default for the session's model. */
    effort?: string;
    /** Text appended to the Claude Code system prompt. The system prompt is
     * rebuilt on each run, so this must be supplied on resumed turns too. */
    appendSystemPrompt?: string;
    /** Permission mode for the run. `plan` keeps the turn read-only on the
     * project while research tools still run. */
    permissionMode?: ClaudePermissionMode;
    /** Tool names removed from the model's context. */
    disallowedTools?: string[];
    /** Built-in tools: `["default"]` is the full Claude Code set. An explicit
     * empty array disables every built-in rather than being omitted, so an
     * empty whitelist can never silently widen back to the full set. MCP tools
     * are outside this option's scope; gate those with hooks or settings. */
    tools?: string[];
    /** Tools pre-approved without a permission check. Auto-allow only: this
     * never restricts the tool set. */
    allowedTools?: string[];
    /** Settings sources the CLI may load ("user", "project", "local").
     * Omitted = all of them. Omitting a source drops its permission rules for
     * the turn — e.g. excluding "user" keeps a broad `permissions.allow` in
     * ~/.claude/settings.json from pre-approving what the turn's permission
     * mode would otherwise gate. */
    settingSources?: Array<"user" | "project" | "local">;
    /** Extra flag settings: a JSON string, a file path, or an object. Merged
     * on top of the loaded setting sources. */
    settings?: string | Record<string, unknown>;
    /** In-process hook callbacks (e.g. a PreToolUse guard). A callback that
     * throws counts as no opinion, so a guard must catch its own errors. */
    hooks?: ClaudeHooks;
    /** Pre-assign a UUID for the new session (turn 1). Mutually exclusive with resumeSessionId. */
    newSessionId?: string;
    /** Resume an existing session by id (turn 2+). Mutually exclusive with newSessionId. */
    resumeSessionId?: string;
    /** Run a non-persistent one-shot request with customizations, tools, and MCP
     * disabled. Intended for small metadata tasks such as chat titles. */
    isolated?: boolean;
    /** Test seam: replaces the Agent SDK's `query()`. */
    queryFn?: ClaudeQueryFn;
}
/** Run one Claude Code turn through the Agent SDK: start a session, run the
 * turn, and close the session. Hosts that keep a conversation going should
 * hold a {@link createClaudeSession} session instead, which keeps the CLI up
 * between turns. */
declare function runClaude(opts: RunClaudeOptions): Promise<RunResult>;

/** What a Claude turn produced once its `result` arrived (or the stream ended
 * without one). */
interface ClaudeTurnOutcome {
    /** The result text, else the last parent assistant message, trimmed. */
    text: string;
    sessionId?: string;
    usage?: TokenUsage;
    /** The `result` reported a failed turn. */
    isError: boolean;
    /** The error `result`'s messages, when it carried any. */
    errors: string[];
}
interface ClaudeTurnTranslator {
    /** Feed one stream-json message (a CLI stdout line or an SDK message). */
    handle(message: unknown): void;
    /** A further user message (a steer) was sent into this turn under `uuid`;
     * a `result` naming it is the turn's own, and the turn is not done until
     * one has answered it. */
    expectUserMessage(uuid: string): void;
    /** True once the turn's own `result` has arrived, every steer has been
     * answered, and no subagent it started is still owed a follow-up: every
     * live one has settled and the CLI has answered its notification with a
     * further `result`. */
    readonly done: boolean;
    /** The turn's own `result` has arrived, whether or not it is done. */
    readonly resultSeen: boolean;
    /** The turn's own `result` is in and every subagent has settled, but the
     * CLI still owes a `result`: the answer to a subagent's notification, or to
     * a steer it took up as a turn of its own. */
    readonly awaitingFollowUp: boolean;
    /** A `result` this turn named the prompts it answers, so the CLI echoes
     * prompt uuids. */
    readonly echoedPromptUuid: boolean;
    /** Tasks (background Bash, Monitor, subagents) started this turn that have
     * not settled yet. */
    readonly liveTaskIds: ReadonlySet<string>;
    /** The subagents among {@link liveTaskIds}. */
    readonly liveAgentTaskIds: ReadonlySet<string>;
    finish(): ClaudeTurnOutcome;
}
interface ClaudeTurnTranslatorOptions {
    /** The uuid stamped on this turn's prompt. With it, a `result` that answers
     * something else — a task the CLI settles on resume, another prompt — is
     * not taken for this turn's. Without it, every `result` is this turn's. */
    promptUuid?: string;
    /** An earlier turn of the same process saw a `result` name its prompt, so
     * one that names none is never this turn's own. */
    cliEchoesPromptUuid?: boolean;
}
/** Translate one Claude turn's stream-json messages into host callbacks. One
 * translator per turn: session-id deduplication, usage attribution, and task
 * tracking are all scoped to it. */
declare function createClaudeTurnTranslator(callbacks: AgentCallbacks, options?: ClaudeTurnTranslatorOptions): ClaudeTurnTranslator;

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
    /** Register the single handler that answers server-initiated requests.
     * Only one registration may be active at a time: a second call throws
     * while the first is live, and the slot reopens once the returned
     * disposer runs. */
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
    /** Hand more input to the running turn through `turn/steer`, once the turn
     * is identified. Rejects with a {@link SteerRejectedError} when no turn is
     * running, the turn ends first, or the app-server refuses the steer. */
    steer(options: CodexAppServerSteerOptions): Promise<void>;
    onClose(handler: (error: Error) => void): () => void;
    close(): Promise<void>;
}
interface CodexAppServerSteerOptions {
    /** More input for the running turn, as the user would type it mid-turn. */
    prompt: string;
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
/** A steer the session could not hand to the running turn: none is running,
 * or the turn is past the point of taking more input. The host can send the
 * same words as the next turn instead. */
declare class SteerRejectedError extends Error {
    readonly name = "SteerRejectedError";
}

/**
 * Live model discovery for both providers, shared by hosts that let users
 * pick a model/effort: Codex models come from the app-server's `model/list`
 * API (with per-model reasoning efforts and service tiers); Claude aliases
 * and effort levels are parsed from the installed CLI's `--help`, with
 * static fallbacks when discovery is unavailable.
 *
 * Policy stays with the host: `config.defaultEffort` names the effort a host
 * sends when a thread has none saved (advertised as each model's
 * `defaultEffort` so UIs match the runs). Hosts that omit it get the
 * provider-reported default, or null — meaning "omit the option and let the
 * CLI/config decide".
 */
type ModelCatalogProvider = "claude" | "codex";
interface ModelEffortOption {
    id: string;
    label: string;
}
interface ModelServiceTierOption {
    id: string;
    name: string;
    description: string;
}
interface ModelOption {
    id: string;
    label: string;
    description?: string;
    efforts: ModelEffortOption[];
    serviceTiers: ModelServiceTierOption[];
    defaultEffort: string | null;
    isDefault: boolean;
}
interface ModelCatalog {
    provider: ModelCatalogProvider;
    source: "codex-app-server" | "codex-config" | "claude-cli" | "claude-fallback";
    fetchedAt: string;
    supportsCustomModel: boolean;
    models: ModelOption[];
}
interface ModelSelectionInput {
    model: string | null;
    effort?: string | null;
    serviceTier?: string | null;
}
interface ModelSelection {
    model: string | null;
    effort: string | null;
    serviceTier: string | null;
}
interface CodexModelDescriptor {
    model: string;
    displayName?: string;
    description?: string;
    hidden?: boolean;
    isDefault?: boolean;
    defaultReasoningEffort?: string | null;
    supportedReasoningEfforts?: Array<{
        reasoningEffort: string;
    }>;
    serviceTiers?: ModelServiceTierOption[];
}
interface CodexModelListResponse {
    data?: CodexModelDescriptor[];
    nextCursor?: string | null;
}
declare function collectCodexModels(requestPage: (cursor?: string) => Promise<CodexModelListResponse>): Promise<CodexModelDescriptor[]>;
interface ModelCatalogService {
    getCatalog(provider: ModelCatalogProvider, cwd: string): Promise<ModelCatalog>;
    validateSelection(catalog: ModelCatalog, input: ModelSelectionInput): ModelSelection;
}
interface ModelCatalogConfig {
    /** Codex binary for `model/list` discovery. Defaults to "codex" on PATH. */
    codexPath?: string;
    /** Claude binary for `--help` discovery. Defaults to "claude" on PATH. */
    claudePath?: string;
    /** A host-configured Codex model: always present in the catalog (marked
     * default), and the discovery fallback when the app-server is unreachable. */
    codexModel?: string;
    /** The effort the host sends when a thread has none saved, advertised as
     * every model's `defaultEffort`. Omitted = the provider-reported default,
     * or null ("omit the option; the CLI/config decides"). */
    defaultEffort?: string;
    /** Description shown on the synthetic configured-model entry. */
    configuredModelDescription?: string;
}
interface ModelCatalogDeps {
    listCodexModels?: (executablePath: string, cwd: string) => Promise<CodexModelDescriptor[]>;
    getClaudeCapabilities?: (executablePath: string, cwd: string) => Promise<ClaudeCliCapabilities>;
    now?: () => Date;
}
interface ClaudeCliCapabilities {
    aliases: string[];
    efforts: string[];
}
declare function parseClaudeCliHelp(help: string): ClaudeCliCapabilities;
declare function createModelCatalogService(config?: ModelCatalogConfig, deps?: ModelCatalogDeps): ModelCatalogService;

type ProviderUpdateProvider = "claude" | "codex";
type ProviderUpdateState = "current" | "update_available" | "not_installed" | "unknown";
type ProviderUpdateReason = "cli_not_found" | "unsupported_installation" | "version_unavailable" | "check_failed" | null;
interface ProviderUpdateStatus {
    provider: ProviderUpdateProvider;
    state: ProviderUpdateState;
    installedVersion: string | null;
    latestVersion: string | null;
    channel: "stable" | "latest" | null;
    checkedAt: string;
    reason: ProviderUpdateReason;
}
/** Why an update never reached the installer, or died before reporting.
 * `null` only means "no category applies" — it does not imply the installer
 * ran, since an unclassified spawn failure lands here too. Use
 * `exitCode !== null` to tell whether the installer actually decided. */
type ProviderUpdateApplyReason = "cli_not_found" | "unsupported_installation"
/** The install method could not be read, so it was not safe to assume the
 * updater owns this binary — distinct from knowing it does not. */
 | "install_method_unknown" | "timed_out" | null;
interface ProviderUpdateApplyResult {
    provider: ProviderUpdateProvider;
    ok: boolean;
    /** null when no process produced one — a refusal, a spawn failure, or a kill. */
    exitCode: number | null;
    /** Combined stdout + stderr, untrimmed; the caller decides how much to keep. */
    output: string;
    /** Set for refusals and spawn/timeout failures; null for a plain nonzero exit,
     * where `output` already carries the installer's own explanation. */
    error: string | null;
    reason: ProviderUpdateApplyReason;
}
interface ProviderUpdateService {
    check(provider: ProviderUpdateProvider): Promise<ProviderUpdateStatus>;
    checkAll(): Promise<ProviderUpdateStatus[]>;
    /** Run the provider's own updater. Never throws: every failure mode comes
     * back as a result so a host can render it. */
    apply(provider: ProviderUpdateProvider): Promise<ProviderUpdateApplyResult>;
}
interface ProviderUpdateServiceConfig {
    claudePath?: string;
    codexPath?: string;
    env?: NodeJS.ProcessEnv;
}
interface ProviderUpdateCommandOptions {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
}
interface ProviderUpdateCommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
interface ProviderUpdateFetchOptions {
    timeoutMs: number;
}
interface ProviderUpdateServiceDeps {
    runCommand?: (executable: string, args: readonly string[], options: ProviderUpdateCommandOptions) => Promise<ProviderUpdateCommandResult>;
    fetchText?: (url: string, options: ProviderUpdateFetchOptions) => Promise<string>;
    now?: () => Date;
}
declare function createProviderUpdateService(config?: ProviderUpdateServiceConfig, deps?: ProviderUpdateServiceDeps): ProviderUpdateService;

export { AbortError, type AgentCallbacks, type BackgroundAgentInfo, type BackgroundAgentProgress, type BackgroundAgentStatus, CLAUDE_FOLLOW_UP_GRACE_MS, CLAUDE_INTERRUPT_GRACE_MS, CLAUDE_STRIPPED_ENV_VARS, CODEX_STRIPPED_ENV_VARS, type ClaudeCliCapabilities, type ClaudeHooks, type ClaudePermissionMode, type ClaudeQuery, type ClaudeQueryFn, type ClaudeSession, type ClaudeSessionSteerOptions, type ClaudeSessionTurnOptions, type ClaudeTurnOutcome, type ClaudeTurnTranslator, type ClaudeTurnTranslatorOptions, type CodexAppServerClient, type CodexAppServerSession, type CodexAppServerSteerOptions, type CodexAppServerTurnOptions, type CodexModelDescriptor, type CodexSandboxPolicy, type CodexServerRequest, type CodexServerRequestHandler, CodexTurnError, type CommonRunOptions, type CreateClaudeSessionOptions, type CreateCodexAppServerClientOptions, type CreateCodexAppServerSessionOptions, KNOWN_CONTEXT_WINDOWS, MissingCliError, type ModelCatalog, type ModelCatalogConfig, type ModelCatalogDeps, type ModelCatalogProvider, type ModelCatalogService, type ModelEffortOption, type ModelOption, type ModelSelection, type ModelSelectionInput, type ModelServiceTierOption, type ProviderUpdateApplyReason, type ProviderUpdateApplyResult, type ProviderUpdateCommandOptions, type ProviderUpdateCommandResult, type ProviderUpdateFetchOptions, type ProviderUpdateProvider, type ProviderUpdateReason, type ProviderUpdateService, type ProviderUpdateServiceConfig, type ProviderUpdateServiceDeps, type ProviderUpdateState, type ProviderUpdateStatus, type RunClaudeOptions, type RunCodexOptions, type RunResult, type SpawnFn, SteerRejectedError, TimeoutError, type TokenUsage, type ToolPlanItem, type ToolResultInfo, type ToolUseInfo, collectCodexModels, contextWindowForModel, createClaudeSession, createClaudeTurnTranslator, createCodexAppServerClient, createCodexAppServerSession, createModelCatalogService, createProviderUpdateService, parseClaudeCliHelp, runClaude, runCodex };
