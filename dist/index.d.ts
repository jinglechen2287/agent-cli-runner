import { HookEvent, HookCallbackMatcher, SDKUserMessage, Options, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
export { HookCallback as ClaudeHookCallback, HookCallbackMatcher as ClaudeHookCallbackMatcher, HookInput as ClaudeHookInput, HookJSONOutput as ClaudeHookOutput, McpServerConfig as ClaudeMcpServerConfig, PreToolUseHookInput as ClaudePreToolUseHookInput, PreToolUseHookSpecificOutput as ClaudePreToolUseHookOutput } from '@anthropic-ai/claude-agent-sdk';
import { SpawnOptions, ChildProcess } from 'node:child_process';

/**
 * The providers this library runs, and what it can do with each of them.
 * The capabilities are facts about the CLIs as this library drives them;
 * host policy (which turns a product allows, say) stays with the host.
 */
type AgentProvider = "claude" | "codex" | "agy";
/** What this library can do with one CLI. */
interface ProviderCapabilities {
    /** A turn can run on a chosen service tier (`serviceTier`). */
    serviceTiers: boolean;
    /** `compact()` takes focus instructions for the summary. */
    compactionFocus: boolean;
    /** A run can be a throwaway fork of a session (`forkSessionId`). */
    sideFork: boolean;
    /** A session can be copied into a new one that carries on
     * (`forkClaudeSession` / `forkCodexThread`). */
    lastingFork: boolean;
    /** A saved session can be deleted (`deleteClaudeSession`). */
    deleteSession: boolean;
    /** `onMcpStatus` fires (on long-lived sessions). */
    mcpStatus: boolean;
    /** `onMcpElicitation` can be asked. */
    mcpElicitation: boolean;
    /** In-process hooks can guard every tool call before it runs. */
    toolHooks: boolean;
    /** The host answers the CLI's own permission requests per call
     * (`onPermissionRequest`). */
    permissionCallback: boolean;
    /** A turn can be held read-only by the CLI (Codex's read-only sandbox,
     * Claude's plan permission mode). */
    readOnlyTurns: boolean;
    /** Prompts can carry local images (`imagePaths`). */
    images: boolean;
    /** A failed turn rejects with a ProviderTurnError ("rejects") or resolves
     * with exitCode 1 ("resolves"). */
    failedTurn: "rejects" | "resolves";
}
declare const PROVIDER_CAPABILITIES: Readonly<Record<AgentProvider, Readonly<ProviderCapabilities>>>;

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
 * Anthropic models are handled by {@link CLAUDE_CONTEXT_WINDOWS} instead.
 */
declare const KNOWN_CONTEXT_WINDOWS: Readonly<Record<string, number>>;
/**
 * The window Claude Code runs each Claude model at by default, keyed by
 * canonical id — the value it later reports in a turn's `modelUsage`. Copied
 * from Claude Code 2.1.312's built-in model registry; to re-check after a CLI
 * update, search the binary's strings for `context:{window:`. Claude Code also
 * honors a `[1m]` marker on any model, handled before this table.
 */
declare const CLAUDE_CONTEXT_WINDOWS: Readonly<Record<string, number>>;
/**
 * Best-effort context window (in tokens) for a model id, or `undefined` when it
 * can't be determined. Consults {@link KNOWN_CONTEXT_WINDOWS} first. Claude ids
 * resolve through {@link CLAUDE_CONTEXT_WINDOWS} (1M for any `[1m]` variant,
 * and a generation guess for models newer than the table); Codex `gpt-5.6*` /
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
    /** The tool call that started the subagent making this call (Claude's
     * `parent_tool_use_id`). Absent on the parent turn's own calls. */
    parentToolCallId?: string;
}
/** A completed tool result as reported by the provider. Hosts should treat
 * `content` as opaque unless they recognize the corresponding tool. */
interface ToolResultInfo {
    /** Matches {@link ToolUseInfo.callId}. */
    callId: string;
    content: unknown;
    isError?: boolean;
    /** The tool's full structured output, opaque (Claude's `tool_use_result`):
     * its shape is per tool, keyed by the call's name. Absent when the CLI sent
     * none, or when one message answered several calls and it can't be told
     * whose it is. */
    structured?: unknown;
    /** See {@link ToolUseInfo.parentToolCallId}. */
    parentToolCallId?: string;
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
    /** Claude task id, Codex child thread id, or the agy tool call that
     * started the subagent. Stable within the parent turn. */
    id: string;
    provider: AgentProvider;
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
/** Where one MCP server stands, normalized across providers. */
interface McpServerStatusInfo {
    name: string;
    status: "connecting" | "connected" | "failed" | "needs-auth" | "disabled";
    /** Why it failed, when the provider says. */
    error?: string;
}
/** An MCP server asking the user for something mid-tool-call. Provider-specific
 * forms a host could not answer never reach it: the runner declines those. */
type McpElicitationRequest = {
    serverName: string;
    message: string;
} & ({
    mode: "form";
    requestedSchema: Record<string, unknown>;
} | {
    mode: "url";
    url: string;
});
interface McpElicitationResponse {
    action: "accept" | "decline" | "cancel";
    /** The form's values, on `accept` of a form. */
    content?: Record<string, unknown>;
}
/** The agent's conversation was compacted: its history replaced by a summary
 * so the context window has room again. */
interface CompactionInfo {
    /** `manual` when the host asked for it, `auto` when the CLI decided to. */
    trigger: "manual" | "auto";
    /** Tokens in the context before compacting, as the CLI counted them. */
    preTokens?: number;
    /** The CLI's own estimate of what is left. Claude counts it differently
     * from {@link TokenUsage.contextTokens}, so it is no stand-in for that. */
    postTokens?: number;
}
/** The CLI began compacting the conversation. */
interface CompactionStartInfo {
    /** `manual` when the host asked for it, `auto` when the CLI decided to. */
    trigger: "manual" | "auto";
}
/** The CLI gave up on a compaction, leaving the conversation as it was. */
interface CompactionFailureInfo {
    /** `manual` when the host asked for it, `auto` when the CLI decided to. */
    trigger: "manual" | "auto";
    /** The CLI's reason, when it gave one. */
    error?: string;
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
    /** Fired when the conversation is compacted, whether a host asked for it
     * (`compact()` on a session) or the CLI did it on its own mid-turn. The
     * size after compacting arrives through {@link onUsage}, when it is known. */
    onCompaction?: (info: CompactionInfo) => void;
    /** The CLI began compacting; onCompaction or onCompactionFailed ends it, or the turn settling does. */
    onCompactionStart?: (info: CompactionStartInfo) => void;
    /** Claude only: the CLI ended a compaction without compacting (it failed, or a hook or the CLI called it off), and the turn may go on. */
    onCompactionFailed?: (info: CompactionFailureInfo) => void;
    /** Fired with the MCP servers' status at the start of each turn on a
     * long-lived session and whenever one changes during it. Each call is a
     * snapshot that replaces the last, of every server the CLI reports: Claude
     * lists disabled ones, while Codex only reports servers it starts. Claude runs and Codex sessions:
     * a one-off Codex run does not report status. */
    onMcpStatus?: (servers: McpServerStatusInfo[]) => void;
    /** Answers an MCP server's request for user input while the tool call waits.
     * Without it a request is declined. A throw cancels it, and `signal` fires
     * when the request stops mattering (the turn ended, the session closed, or
     * the CLI gave up), at which point the answer is ignored. Claude runs and
     * Codex sessions: a one-off Codex run leaves requests to Codex.
     *
     * Codex decides first: under approval policy `never` it answers most
     * requests itself, so only forms with fields in a full-access turn get here.
     * See the README. */
    onMcpElicitation?: (request: McpElicitationRequest, context: {
        signal: AbortSignal;
    }) => Promise<McpElicitationResponse>;
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
    /** Claude session id / Codex thread id / agy session id, when the CLI
     * reported one. */
    sessionId?: string;
    /** The latest context-usage snapshot of the turn, when the CLI reported any
     * token counts. Matches the final {@link AgentCallbacks.onUsage} value. */
    usage?: TokenUsage;
}

/** Claude Code permission modes. `manual` is this package's name for the
 * CLI's `default` (prompt-for-everything) mode. */
type ClaudePermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan";
/** In-process hook callbacks, keyed by hook event — the Agent SDK's shape. */
type ClaudeHooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>;
/** The slice of the Agent SDK's `Query` a session drives. */
interface ClaudeQuery extends AsyncIterable<unknown> {
    interrupt(): Promise<unknown>;
    close(): void;
    /** Absent on a scripted query that doesn't model it. */
    mcpServerStatus?(): Promise<ReadonlyArray<{
        name: string;
        status: string;
        error?: string;
    }>>;
    /** The data behind `/context`. Absent on a scripted query that doesn't model it. */
    getContextUsage?(opts?: {
        detail?: "summary" | "full";
    }): Promise<ClaudeContextUsage>;
}
/** The slice of the Agent SDK's context-usage answer a session reads. */
interface ClaudeContextUsage {
    /** Tokens the context holds now, counted with the token-count API. */
    totalTokens: number;
    /** The window those tokens are measured against. */
    maxTokens?: number;
    model?: string;
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
/** How long a held turn waits for the CLI to open an answer to a subagent's
 * notification once nothing else is owed: it opens one at once, so silence
 * this long means the last answer already took the notification in. */
declare const CLAUDE_ABSORBED_FOLLOW_UP_GRACE_MS = 5000;
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
    /** MCP servers for the session, by name, on top of those the settings
     * sources configure. */
    mcpServers?: Record<string, McpServerConfig>;
    /** Only the MCP servers in `mcpServers`: the CLI ignores a project .mcp.json,
     * local- and user-scope MCP config, and plugins' servers. claude.ai connectors
     * are a separate switch: `settings: { disableClaudeAiConnectors: true }`.
     * `isolated` implies it. */
    strictMcpConfig?: boolean;
    /** A non-persistent session with customizations, tools, and MCP disabled,
     * for small metadata tasks such as chat titles. */
    isolated?: boolean;
    /** Fork this existing session for a side run: it sees that session's
     * history and writes nothing back. With `isolated` it may use no tool;
     * without, it keeps the tools, permission mode, settings and hooks given
     * here, as any guarded session would. Mutually exclusive with
     * newSessionId and resumeSessionId. */
    forkSessionId?: string;
    /** Override {@link CLAUDE_INTERRUPT_GRACE_MS}. */
    interruptGraceMs?: number;
    /** Override {@link CLAUDE_FOLLOW_UP_GRACE_MS}. */
    followUpGraceMs?: number;
    /** Override {@link CLAUDE_ABSORBED_FOLLOW_UP_GRACE_MS}. */
    absorbedFollowUpGraceMs?: number;
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
type ClaudeSessionCompactOptions = AgentCallbacks & {
    /** What the summary should keep, as typed after Claude Code's `/compact`. */
    instructions?: string;
    /** As on {@link ClaudeSessionTurnOptions}. */
    signal?: AbortSignal;
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
    /** Compact the conversation with Claude Code's own `/compact`, as a turn of
     * its own: it settles with empty text, and reports the size left through
     * `onUsage` and the result's `usage` when the CLI can measure it. It can't
     * be steered. */
    compact(options: ClaudeSessionCompactOptions): Promise<RunResult>;
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
    /** Only the MCP servers the session is given: the CLI ignores a project
     * .mcp.json, local- and user-scope MCP config, and plugins' servers.
     * claude.ai connectors are a separate switch:
     * `settings: { disableClaudeAiConnectors: true }`. `isolated` implies it. */
    strictMcpConfig?: boolean;
    /** Pre-assign a UUID for the new session (turn 1). Mutually exclusive with resumeSessionId. */
    newSessionId?: string;
    /** Resume an existing session by id (turn 2+). Mutually exclusive with newSessionId. */
    resumeSessionId?: string;
    /** Run a non-persistent one-shot request with customizations, tools, and MCP
     * disabled. Intended for small metadata tasks such as chat titles. */
    isolated?: boolean;
    /** Fork this existing session for a side run: it sees that session's
     * history and writes nothing back. With `isolated` it may use no tool;
     * without, it keeps the tools, permissions and hooks given here. */
    forkSessionId?: string;
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
    /** Waiting only on answers to notifications that landed while the CLI was
     * answering another, with the CLI answering nothing now: it opens each
     * queued answer at once, so if none opens, the answer just written took
     * them in between tool rounds. */
    readonly followUpMayBeAbsorbed: boolean;
    /** The conversation was compacted during this turn. */
    readonly compacted: boolean;
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
    /** State shared by every turn of one Claude session. Without it, the
     * translator keeps its own, as a one-turn run needs no more. */
    session?: ClaudeSessionState;
    /** The host asked for this turn to compact (`/compact`), so a compaction it reports is `manual`; otherwise the CLI started it, `auto`. */
    compact?: boolean;
}
/** What a Claude session learns in one turn and the next turn needs: the
 * start-up line names the qualified model only once per process, and a
 * `result` reports each model's real window only at the end of a turn. */
interface ClaudeSessionState {
    /** The init line's fully-qualified model id, variant marker included. */
    model?: string;
    /** The window each model's `result` reported, keyed by its exact id, so
     * a later turn's live usage matches what its result will report. */
    contextWindows: Map<string, number>;
}
/** Fresh state for a new Claude session. */
declare function createClaudeSessionState(): ClaudeSessionState;
/** Translate one Claude turn's stream-json messages into host callbacks. One
 * translator per turn: session-id deduplication, usage attribution, and task
 * tracking are all scoped to it. */
declare function createClaudeTurnTranslator(callbacks: AgentCallbacks, options?: ClaudeTurnTranslatorOptions): ClaudeTurnTranslator;

interface JsonRpcServerRequest {
    id: number | string;
    method: string;
    params: unknown;
}
type JsonRpcServerRequestHandler = (request: JsonRpcServerRequest) => Promise<unknown> | unknown;
interface JsonRpcClient {
    /** `timeoutMs` null sends the request with no timer at all (a request that
     * stays open for a whole turn); undefined uses the client's default. */
    request(method: string, params?: Record<string, unknown>, timeoutMs?: number | null): Promise<unknown>;
    notify(method: string, params?: unknown): void;
    onNotification(handler: (method: string, params: unknown) => void): () => void;
    /** Register the single handler that answers server-initiated requests.
     * Only one registration may be active at a time: a second call throws
     * while the first is live, and the slot reopens once the returned
     * disposer runs. */
    onServerRequest(handler: JsonRpcServerRequestHandler): () => void;
    onStderr(handler: (chunk: string) => void): () => void;
    /** A stdout line that is not JSON, e.g. a sign-in link a CLI prints. */
    onStdoutNonJson(handler: (line: string) => void): () => void;
    onClose(handler: (error: Error) => void): () => void;
    close(): void;
}

type CodexServerRequest = JsonRpcServerRequest;
type CodexServerRequestHandler = JsonRpcServerRequestHandler;
type CodexAppServerClient = JsonRpcClient;
interface CreateCodexAppServerClientOptions {
    executablePath?: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    spawnFn?: RunCodexOptions["spawnFn"];
    requestTimeoutMs?: number;
    /** MCP extensions this client supports, declared at `initialize`. */
    extensions?: {
        [id: string]: CodexJsonValue;
    };
    /** Gives up on starting: closes the app-server and rejects with
     * `AbortError`. Only the start; close the client to stop it after. */
    signal?: AbortSignal;
}
/** app-server's `config` map: dotted or nested config.toml keys to values. */
type CodexConfigOverrides = {
    [key: string]: CodexJsonValue;
};
type CodexJsonValue = string | number | boolean | null | CodexJsonValue[] | {
    [key: string]: CodexJsonValue;
};
declare function createCodexAppServerClient(options: CreateCodexAppServerClientOptions): Promise<CodexAppServerClient>;

type CodexAppServerTurnOptions = Omit<RunCodexOptions, "appServerClient" | "appServerSession" | "cwd" | "dangerouslyBypassApprovalsAndSandbox" | "developerInstructions" | "env" | "executablePath" | "isolated" | "resumeSessionId" | "forkSessionId" | "forkConfig" | "spawnFn">;
interface CodexAppServerSession {
    readonly threadId: string;
    readonly cwd: string;
    readonly closed: boolean;
    runTurn(options: CodexAppServerTurnOptions): Promise<RunResult>;
    /** Hand more input to the running turn through `turn/steer`, once the turn
     * is identified. Rejects with a {@link SteerRejectedError} when no turn is
     * running, the turn ends first, or the app-server refuses the steer. */
    steer(options: CodexAppServerSteerOptions): Promise<void>;
    /** Compact the thread with Codex's own `thread/compact/start`, as a turn of
     * its own: it settles with empty text, and reports Codex's estimate of the
     * compacted history through `onUsage`. It can't be steered. */
    compact(options: CodexAppServerCompactOptions): Promise<RunResult>;
    onClose(handler: (error: Error) => void): () => void;
    close(): Promise<void>;
}
type CodexAppServerCompactOptions = AgentCallbacks & {
    /** As on a turn: aborting interrupts the compaction. */
    signal?: AbortSignal;
    timeoutMs?: number;
};
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
    /** Config overrides for the thread, sent on `thread/start` and
     * `thread/resume` — e.g. `{ mcp_servers: { name: { url } } }`. */
    config?: CodexConfigOverrides;
    /** Archive the thread with `thread/archive` when the session closes, once
     * it has run a turn: the rollout moves to Codex's archived sessions, kept
     * on disk but out of the history a Codex client lists by default. */
    archive?: boolean;
    /** How long close waits for the archive; 2 s unless given. */
    archiveTimeoutMs?: number;
    /** Told the thread's id when close couldn't archive it: Codex refused, didn't
     * answer in time, or had already exited. The session closes all the same. */
    onArchiveError?: (threadId: string, error: Error) => void;
}
declare function createCodexAppServerSession(options: CreateCodexAppServerSessionOptions): Promise<CodexAppServerSession>;

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
/** Run a Codex turn. Regular work uses app-server; only isolated metadata
 * requests retain the legacy non-interactive `codex exec` path. */
declare function runCodex(opts: RunCodexOptions): Promise<RunResult>;

/** Copy a Claude Code session under new ids, as a session of its own that
 * `resumeSessionId` continues. `cwd` is the directory the session was kept
 * for. Reads and writes the session files where the CLI keeps them, under
 * this process's `CLAUDE_CONFIG_DIR` (or the default). Answers the copy's id. */
declare function forkClaudeSession(sessionId: string, options: {
    cwd: string;
}): Promise<string>;
/** Delete a Claude Code session kept for `cwd` — say, a fork no one took up. */
declare function deleteClaudeSession(sessionId: string, options: {
    cwd: string;
}): Promise<void>;
interface ForkCodexThreadOptions {
    /** The thread to copy. */
    threadId: string;
    cwd: string;
    executablePath?: string;
    env?: NodeJS.ProcessEnv;
    /** Bounds the whole fork, the app-server's start included. Default 60 s. */
    timeoutMs?: number;
    signal?: AbortSignal;
    spawnFn?: RunCodexOptions["spawnFn"];
}
/** Fork a Codex thread into a new one that is kept, as one `resumeSessionId`
 * continues, through a one-shot app-server that is closed however the fork
 * ends. Answers the new thread's id. */
declare function forkCodexThread(options: ForkCodexThreadOptions): Promise<string>;

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
type ProviderTurnErrorKind = "usage_limit" | "provider_error" | "auth_required" | "unsupported" | "invalid_request";
interface ProviderTurnErrorOptions {
    /** Defaults to "provider_error". */
    kind?: ProviderTurnErrorKind;
    /** The provider's own code, e.g. "RESOURCE_EXHAUSTED" or -32000. */
    code?: string | number;
    /** Whether sending the same turn again may succeed. Defaults to false. */
    retryable?: boolean;
    /** ISO time when a usage limit resets, when the provider says. */
    resetAt?: string;
    exitCode?: number;
    cause?: unknown;
}
/** A turn a provider failed, in one shape for every provider, so a host can
 * handle every failure in one place. Claude's failed results resolve with
 * exitCode 1 instead (see PROVIDER_CAPABILITIES' `failedTurn`). */
declare class ProviderTurnError extends Error {
    name: string;
    readonly provider: AgentProvider;
    readonly kind: ProviderTurnErrorKind;
    readonly code?: string | number;
    readonly retryable: boolean;
    readonly resetAt?: string;
    /** Exit code of the provider's process, once known. */
    exitCode?: number;
    constructor(provider: AgentProvider, message: string, options?: ProviderTurnErrorOptions);
}
/** A fatal `error` / `turn.failed` event in the Codex JSONL stream. */
declare class CodexTurnError extends ProviderTurnError {
    name: string;
    constructor(message: string, options?: ProviderTurnErrorOptions);
}
interface AgyTurnErrorOptions extends ProviderTurnErrorOptions {
    /** The ACP stop reason the prompt ended with, when it ended with one. */
    stopReason?: string;
    /** agy's saved conversation can no longer be sent to the model: start a
     * fresh session. */
    broken?: boolean;
    /** The turn's last assistant prose. */
    text?: string;
}
/** A failed agy turn: an error agy logged, a stop reason other than
 * `end_turn`, or a request the session refused. */
declare class AgyTurnError extends ProviderTurnError {
    name: string;
    readonly stopReason?: string;
    readonly broken: boolean;
    readonly text?: string;
    constructor(message: string, options?: AgyTurnErrorOptions);
}
/** agy needs the user to sign in (`agy`, or `agy acp --login`). */
declare class AgyAuthError extends ProviderTurnError {
    name: string;
    /** The sign-in link agy printed, when it printed one. */
    readonly url?: string;
    readonly data?: unknown;
    constructor(message: string, options?: {
        code?: number;
        url?: string;
        data?: unknown;
    });
}
/** Thrown by a {@link CodexServerRequestHandler} for a method it does not
 * take: the server gets "method not found", as if nothing were registered. */
declare class UnsupportedServerRequestError extends Error {
    constructor(method: string);
}
/** A steer the session could not hand to the running turn: none is running,
 * or the turn is past the point of taking more input. The host can send the
 * same words as the next turn instead. */
declare class SteerRejectedError extends Error {
    readonly name = "SteerRejectedError";
}

/**
 * agy reports an upstream API failure (a quota, a rate limit, a broken
 * conversation) as a chat message and a plain `end_turn`. Its session log
 * ends that turn with an error step, so after each prompt the session reads
 * the steps the prompt added and classifies the last one. Ported from T3
 * Code's AntigravityTurnOutcome: the step types and the regexes are T3's.
 */

/** The newest step a prompt added. */
interface AgyLastStep {
    type: number;
    payload: Uint8Array | null;
    /** The model answered (a planner-response step) within the prompt. */
    reachedModel: boolean;
}
/** Reads agy's per-session step log, `conversations/<sid>.db`. */
interface AgyStepReader {
    /** The newest step index, or undefined when the log can't be read. */
    lastIndex(dbPath: string): number | undefined;
    /** The newest step after `index`, or undefined when there is none. */
    lastStepAfter(dbPath: string, index: number): AgyLastStep | undefined;
}

/** How long a cancelled prompt may take to answer before the process is
 * stopped (T3 Code's wait). */
declare const AGY_INTERRUPT_GRACE_MS = 15000;
/** An agy execution mode, checked against the modes the session advertises
 * (agy 1.5.13: default, accept-edits, auto, plan). */
type AgyMode = string;
/** An MCP server for the session, in this library's shape. */
type AgyMcpServer = {
    type?: "stdio";
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
} | {
    type: "http" | "sse";
    name: string;
    url: string;
    headers?: Record<string, string>;
};
interface AgyPermissionRequest {
    /** `question`: agy's own question to the user (an `interaction_` call). */
    kind: "approval" | "question";
    toolCall: ToolUseInfo;
    options: Array<{
        id: string;
        name: string;
        kind: string;
    }>;
}
/** An option id from the request, or "cancel". */
type AgyPermissionAnswer = string;
type AgyPermissionCallback = (request: AgyPermissionRequest, context: {
    signal: AbortSignal;
}) => Promise<AgyPermissionAnswer>;
/** Callbacks for output agy produces while no turn is open. */
interface AgyContinuationHandlers extends AgentCallbacks {
    onPermissionRequest?: AgyPermissionCallback;
    /** The continuation ended: its reply finished, or a new turn took over. */
    onEnd?: (outcome: {
        result?: RunResult;
        error?: Error;
    }) => void;
}
interface CreateAgySessionOptions {
    cwd: string;
    executablePath?: string;
    env?: NodeJS.ProcessEnv;
    spawnFn?: SpawnFn;
    /** Gives up on opening the session. */
    signal?: AbortSignal;
    geminiDir?: string;
    appDataDir?: string;
    authMethod?: string;
    resumeSessionId?: string;
    /** The model for every turn that doesn't name its own; "default" keeps
     * agy's current one. */
    model?: string;
    effort?: string;
    mode?: AgyMode;
    appendSystemPrompt?: string;
    mcpServers?: AgyMcpServer[];
    /** Answer every approval agy asks for with "allow once". */
    dangerouslySkipPermissions?: boolean;
    /** A one-off metadata run: a fresh temp cwd, no tools, nothing left behind. */
    isolated?: boolean;
    /** Output agy produces while no turn is open (a finished daemon, a late
     * wake). Without it that output is dropped. */
    onContinuation?: (start: {
        reason: "output" | "permission";
    }) => AgyContinuationHandlers | undefined;
    interruptGraceMs?: number;
    /** How long a turn held for background work waits after agy's reply
     * closes before ending. Default 3 s. */
    replyQuietMs?: number;
    /** Fail a turn that sees no update for this long while nothing it waits on
     * is open. Off unless given. */
    inactivityTimeoutMs?: number;
    /** Test seam: replaces the node:sqlite step reader; null reads no step
     * log, as on a runtime without node:sqlite. */
    stepReader?: AgyStepReader | null;
}
type AgyTurnOptions = AgentCallbacks & {
    prompt: string;
    imagePaths?: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
    model?: string;
    effort?: string;
    mode?: AgyMode;
    onPermissionRequest?: AgyPermissionCallback;
};
type AgyCompactOptions = AgentCallbacks & {
    instructions?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
};
interface AgySession {
    readonly sessionId: string;
    readonly cwd: string;
    readonly closed: boolean;
    /** Where turn errors come from: agy's step log, or the stop reason alone
     * on a runtime without node:sqlite. */
    readonly outcomeSource: "steps-db" | "stop-reason";
    runTurn(options: AgyTurnOptions): Promise<RunResult>;
    /** Hand more input to the running turn. Rejects with SteerRejectedError
     * when no prompt of a turn is outstanding. */
    steer(options: {
        prompt: string;
    }): Promise<void>;
    /** Compact the conversation with agy's `/compact`, as a turn of its own. */
    compact(options: AgyCompactOptions): Promise<RunResult>;
    onClose(handler: (error: Error) => void): () => void;
    close(): Promise<void>;
}
declare function createAgySession(options: CreateAgySessionOptions): Promise<AgySession>;

type RunAgyOptions = CommonRunOptions & Omit<CreateAgySessionOptions, "cwd" | "executablePath" | "env" | "spawnFn" | "signal" | "onContinuation"> & Pick<AgyTurnOptions, "imagePaths" | "onPermissionRequest">;
/** One agy turn: open a session (or resume one), run the prompt, close it. */
declare function runAgy(opts: RunAgyOptions): Promise<RunResult>;

/**
 * Child-process plumbing shared by every runner: finding a CLI, launching it
 * (through cmd.exe for a Windows batch shim), reading its output, and
 * stopping its whole process tree.
 */

/** Nesting-guard variables the Claude CLI uses to refuse running inside
 * another Claude Code session. Stripped so hosts launched by Claude Code
 * (or exposing it, like a bot) can still spawn turns. */
declare const CLAUDE_STRIPPED_ENV_VARS: readonly ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ACCESS_TOKEN"];
/** Stripped so a Codex turn spawned from within another Codex session does
 * not inherit the parent's thread. */
declare const CODEX_STRIPPED_ENV_VARS: readonly ["CODEX_THREAD_ID"];
/** agy sets this inside its own tool shells; stripped so an agy session
 * started from within another agy session does not inherit its conversation. */
declare const AGY_STRIPPED_ENV_VARS: readonly ["ANTIGRAVITY_CONVERSATION_ID"];

/** Thread config for a forked side run: no web search, and every tool
 * feature off, so the copy can only answer from its history. The run adds
 * each configured MCP server, switched off by name, and still fails closed
 * on any item beyond a message or reasoning that starts anyway. */
declare const CODEX_FORK_CONFIG: {
    readonly web_search: "disabled";
    readonly features: {
        readonly multi_agent: false;
        readonly multi_agent_v2: false;
        readonly goals: false;
        readonly shell_tool: false;
        readonly unified_exec: false;
        readonly apps: false;
        readonly image_generation: false;
        readonly view_image: false;
        readonly sleep_tool: false;
        readonly browser_use: false;
        readonly computer_use: false;
    };
};

interface AgyModelDescriptor {
    /** The model option value agy takes in `session/set_config_option`. */
    id: string;
    label: string;
    /** The model's thinking levels, empty when it has none. */
    efforts: string[];
    /** The thinking level agy selects for it. */
    defaultEffort?: string;
    /** agy's current model for a new session. */
    isCurrent: boolean;
}

/**
 * Live model discovery for every provider, shared by hosts that let users
 * pick a model/effort: Codex models come from the app-server's `model/list`
 * API (with per-model reasoning efforts and service tiers); Claude aliases
 * and effort levels are parsed from the installed CLI's `--help`, with
 * static fallbacks when discovery is unavailable; agy models and their
 * thinking levels come from a throwaway ACP session.
 *
 * Policy stays with the host: `config.defaultEffort` names the effort a host
 * sends when a thread has none saved (advertised as each model's
 * `defaultEffort` so UIs match the runs). Hosts that omit it get the
 * provider-reported default, or null — meaning "omit the option and let the
 * CLI/config decide".
 */

type ModelCatalogProvider = AgentProvider;

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
    source: "codex-app-server" | "codex-config" | "claude-cli" | "claude-fallback" | "agy-acp" | "agy-config";
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
    /** agy binary for ACP discovery. Defaults to "agy" on PATH. */
    agyPath?: string;
    /** The catalog's only entry when agy discovery fails. Without it the
     * discovery error is thrown. */
    agyModel?: string;
}
interface ModelCatalogDeps {
    listCodexModels?: (executablePath: string, cwd: string) => Promise<CodexModelDescriptor[]>;
    getClaudeCapabilities?: (executablePath: string, cwd: string) => Promise<ClaudeCliCapabilities>;
    listAgyModels?: (executablePath: string, cwd: string) => Promise<AgyModelDescriptor[]>;
    now?: () => Date;
}
interface ClaudeCliCapabilities {
    aliases: string[];
    efforts: string[];
}
declare function parseClaudeCliHelp(help: string): ClaudeCliCapabilities;
declare function createModelCatalogService(config?: ModelCatalogConfig, deps?: ModelCatalogDeps): ModelCatalogService;

type AgyInstallMethod = "native" | "homebrew" | "unknown";

type ProviderUpdateProvider = AgentProvider;
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
    agyPath?: string;
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
    /** How the agy at this path was installed. */
    resolveAgyInstall?: (executable: string, env: NodeJS.ProcessEnv) => Promise<AgyInstallMethod>;
}
declare function createProviderUpdateService(config?: ProviderUpdateServiceConfig, deps?: ProviderUpdateServiceDeps): ProviderUpdateService;

export { AGY_INTERRUPT_GRACE_MS, AGY_STRIPPED_ENV_VARS, AbortError, type AgentCallbacks, type AgentProvider, AgyAuthError, type AgyCompactOptions, type AgyContinuationHandlers, type AgyLastStep, type AgyMcpServer, type AgyMode, type AgyPermissionAnswer, type AgyPermissionCallback, type AgyPermissionRequest, type AgySession, type AgyStepReader, AgyTurnError, type AgyTurnErrorOptions, type AgyTurnOptions, type BackgroundAgentInfo, type BackgroundAgentProgress, type BackgroundAgentStatus, CLAUDE_ABSORBED_FOLLOW_UP_GRACE_MS, CLAUDE_CONTEXT_WINDOWS, CLAUDE_FOLLOW_UP_GRACE_MS, CLAUDE_INTERRUPT_GRACE_MS, CLAUDE_STRIPPED_ENV_VARS, CODEX_FORK_CONFIG, CODEX_STRIPPED_ENV_VARS, type ClaudeCliCapabilities, type ClaudeContextUsage, type ClaudeHooks, type ClaudePermissionMode, type ClaudeQuery, type ClaudeQueryFn, type ClaudeSession, type ClaudeSessionCompactOptions, type ClaudeSessionState, type ClaudeSessionSteerOptions, type ClaudeSessionTurnOptions, type ClaudeTurnOutcome, type ClaudeTurnTranslator, type ClaudeTurnTranslatorOptions, type CodexAppServerClient, type CodexAppServerCompactOptions, type CodexAppServerSession, type CodexAppServerSteerOptions, type CodexAppServerTurnOptions, type CodexConfigOverrides, type CodexJsonValue, type CodexModelDescriptor, type CodexSandboxPolicy, type CodexServerRequest, type CodexServerRequestHandler, CodexTurnError, type CommonRunOptions, type CompactionFailureInfo, type CompactionInfo, type CompactionStartInfo, type CreateAgySessionOptions, type CreateClaudeSessionOptions, type CreateCodexAppServerClientOptions, type CreateCodexAppServerSessionOptions, type ForkCodexThreadOptions, KNOWN_CONTEXT_WINDOWS, type McpElicitationRequest, type McpElicitationResponse, type McpServerStatusInfo, MissingCliError, type ModelCatalog, type ModelCatalogConfig, type ModelCatalogDeps, type ModelCatalogProvider, type ModelCatalogService, type ModelEffortOption, type ModelOption, type ModelSelection, type ModelSelectionInput, type ModelServiceTierOption, PROVIDER_CAPABILITIES, type ProviderCapabilities, ProviderTurnError, type ProviderTurnErrorKind, type ProviderTurnErrorOptions, type ProviderUpdateApplyReason, type ProviderUpdateApplyResult, type ProviderUpdateCommandOptions, type ProviderUpdateCommandResult, type ProviderUpdateFetchOptions, type ProviderUpdateProvider, type ProviderUpdateReason, type ProviderUpdateService, type ProviderUpdateServiceConfig, type ProviderUpdateServiceDeps, type ProviderUpdateState, type ProviderUpdateStatus, type RunAgyOptions, type RunClaudeOptions, type RunCodexOptions, type RunResult, type SpawnFn, SteerRejectedError, TimeoutError, type TokenUsage, type ToolPlanItem, type ToolResultInfo, type ToolUseInfo, UnsupportedServerRequestError, collectCodexModels, contextWindowForModel, createAgySession, createClaudeSession, createClaudeSessionState, createClaudeTurnTranslator, createCodexAppServerClient, createCodexAppServerSession, createModelCatalogService, createProviderUpdateService, deleteClaudeSession, forkClaudeSession, forkCodexThread, parseClaudeCliHelp, runAgy, runClaude, runCodex };
