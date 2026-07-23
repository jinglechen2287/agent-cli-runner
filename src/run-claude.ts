import { spawn as nodeSpawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { AbortError, MissingCliError, TimeoutError } from "./errors.js";
import {
  createLineSplitter,
  filterEnv,
  isMissingExecutable,
  isUserInputPause,
  normalizeSummary,
  toContextWindow,
  toTokenCount,
  watchLifecycle,
  writePrompt,
} from "./internal.js";
import type {
  BackgroundAgentInfo,
  BackgroundAgentStatus,
  CommonRunOptions,
  RunResult,
  ToolPlanItem,
  UserInputQuestion,
  UserInputRequest,
  UserInputCallbackResult,
  UserInputResponse,
} from "./types.js";
import { contextWindowForModel, type TokenUsage } from "./usage.js";

/** Nesting-guard variables the Claude CLI uses to refuse running inside
 * another Claude Code session. Stripped so hosts launched by Claude Code
 * (or exposing it, like a bot) can still spawn turns. */
export const CLAUDE_STRIPPED_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
] as const;

/** The Claude Code CLI's --permission-mode choices. Like the system prompt,
 * the mode is rebuilt from flags on each run, so it must be supplied on
 * resumed turns too — a session does not remember it. */
export type ClaudePermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "manual"
  | "dontAsk"
  | "plan";

export interface RunClaudeOptions extends CommonRunOptions {
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

interface ClaudeContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** Pull a one-line target out of a Claude tool's `input`: the file it touched,
 * the command it ran, the pattern it searched, and so on. Returns undefined
 * for tools whose input has no single meaningful target (e.g. TodoWrite) or
 * for MCP tools, whose inputs are arbitrary. */
function summarizeClaudeTool(
  name: string,
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (!input) return undefined;
  const str = (key: string): string | undefined => normalizeSummary(input[key]);
  switch (name) {
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
      return str("file_path");
    case "NotebookEdit":
      return str("notebook_path") ?? str("file_path");
    case "Bash":
      return str("command");
    case "Grep":
    case "Glob":
      return str("pattern");
    case "WebFetch":
      return str("url");
    case "WebSearch":
      return str("query");
    case "Task":
    case "Agent":
      return str("description");
    case "TaskCreate":
      return str("subject");
    case "TaskUpdate": {
      const taskId = str("taskId");
      const status = str("status")?.replace(/_/g, " ");
      if (taskId && status) return `Task #${taskId} · ${status}`;
      return taskId ? `Task #${taskId}` : status;
    }
    case "Skill": {
      const skill = str("skill");
      const skillArgs = str("args");
      if (skill && skillArgs) return `${skill} · ${skillArgs}`;
      return skill;
    }
    default:
      return undefined;
  }
}

/** Normalize Claude's TodoWrite `todos` array into the shared plan-item shape,
 * mirroring the Codex plan snapshot so both providers render the same
 * checklist. A malformed entry invalidates the whole list so consumers never
 * present a misleading partial plan. */
function claudeTodoPlanItems(
  name: string,
  input: Record<string, unknown> | undefined,
): ToolPlanItem[] | undefined {
  if (name !== "TodoWrite" || !input || !Array.isArray(input.todos)) return undefined;
  const items: ToolPlanItem[] = [];
  for (const raw of input.todos) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const record = raw as Record<string, unknown>;
    const text = normalizeSummary(record.content) ?? normalizeSummary(record.activeForm);
    const status = normalizeSummary(record.status)?.toLowerCase().replace(/\s+/g, "_");
    if (!text || !status) return undefined;
    items.push({ text, status });
  }
  return items.length > 0 ? items : undefined;
}

/** "N/M steps completed" — the same plan summary Codex reports. */
function planCompletionSummary(planItems: ToolPlanItem[]): string {
  const completed = planItems.filter((item) => item.status === "completed").length;
  return `${completed}/${planItems.length} steps completed`;
}

/** The `usage` block on a Claude `assistant` message and the `result` event.
 * `cache_read_input_tokens` are prior context replayed from cache;
 * `cache_creation_input_tokens` are tokens written to cache this request. Both
 * occupy the context window alongside the fresh `input_tokens`. On a message
 * the counts describe that one request; on `result` they are summed across
 * every request in the turn, so only a single-request turn's result usage
 * doubles as an occupancy snapshot. */
interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_tokens?: number;
  tool_uses?: number;
  duration_ms?: number;
}

/** Per-model rollup on the `result` event. Claude bills each model it used in
 * the turn (a turn may spend a small sub-agent model too) and, crucially,
 * reports each model's `contextWindow` here — the authoritative window size.
 * Straight out of JSON.parse, so fields are unvalidated until read. */
interface ClaudeModelUsage {
  contextWindow?: unknown;
}

/** One `stream_event` payload from `--include-partial-messages`. The CLI wraps
 * the raw Anthropic streaming event, so `content_block_delta` carries the same
 * `delta` union the API uses — text, extended thinking, its signature, or a
 * tool's streamed input JSON. */
interface ClaudeStreamEvent {
  type?: string;
  delta?: { type?: string; text?: string };
}

interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  event?: ClaudeStreamEvent;
  /** Set on lines produced by a background subagent, naming the tool call that
   * spawned it. Null/absent on the parent turn's own output. */
  parent_tool_use_id?: string | null;
  result?: string;
  stop_reason?: string;
  deferred_tool_use?: {
    id?: unknown;
    name?: unknown;
    input?: unknown;
  };
  message?: { content?: ClaudeContentBlock[]; usage?: ClaudeUsage; model?: string };
  usage?: ClaudeUsage;
  modelUsage?: Record<string, ClaudeModelUsage>;
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  task_type?: string;
  subagent_type?: string;
  last_tool_name?: string;
  summary?: string;
  patch?: {
    status?: string;
    description?: string;
    end_time?: number;
    error?: string;
  };
}

function claudeBackgroundAgentStatus(status: string | undefined): BackgroundAgentStatus | undefined {
  switch (status) {
    case "pending":
    case "running":
    case "completed":
    case "failed":
      return status;
    case "killed":
      return "interrupted";
    default:
      return undefined;
  }
}

/** Normalize a Claude usage block into the shared shape. Context occupancy is
 * fresh input plus both cache lanes; only cache *reads* count as "cached". */
function toClaudeUsage(
  usage: ClaudeUsage,
  model: string | undefined,
  contextWindow: number | undefined,
): TokenUsage {
  const input = toTokenCount(usage.input_tokens);
  const cacheRead = toTokenCount(usage.cache_read_input_tokens);
  const cacheCreation = toTokenCount(usage.cache_creation_input_tokens);
  return {
    contextTokens: input + cacheRead + cacheCreation,
    inputTokens: input,
    cachedInputTokens: cacheRead,
    outputTokens: toTokenCount(usage.output_tokens),
    ...(model ? { model } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

/** Drop a Claude model id's `[...]` variant marker so `claude-opus-4-8` (from
 * an assistant message) matches `claude-opus-4-8[1m]` (a modelUsage key). */
function baseModelId(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "");
}

/** Pick the turn's main model from the `result` event's per-model rollup: the
 * one that produced the final assistant message when identifiable, else the one
 * with the largest context window (a sub-agent model has a smaller window). */
function pickPrimaryModel(
  modelUsage: Record<string, ClaudeModelUsage> | undefined,
  preferred: string | undefined,
): { model: string; contextWindow: number | undefined } | undefined {
  if (!modelUsage) return undefined;
  const entries = Object.entries(modelUsage);
  if (entries.length === 0) return undefined;
  if (preferred) {
    const base = baseModelId(preferred);
    const match = entries.find(([key]) => baseModelId(key) === base);
    if (match) return { model: match[0], contextWindow: toContextWindow(match[1].contextWindow) };
  }
  let best = entries[0]!;
  for (const entry of entries) {
    if ((toContextWindow(entry[1].contextWindow) ?? 0) > (toContextWindow(best[1].contextWindow) ?? 0)) {
      best = entry;
    }
  }
  return { model: best[0], contextWindow: toContextWindow(best[1].contextWindow) };
}

interface ClaudeDeferredToolUse {
  id: string;
  name: "AskUserQuestion";
  input: Record<string, unknown>;
}

interface ClaudeProcessResult extends RunResult {
  deferredToolUse?: ClaudeDeferredToolUse;
}

interface ClaudeQuestionContext {
  request: UserInputRequest;
  updatedInput(response: UserInputResponse): Record<string, unknown>;
}

interface ClaudeHookFiles {
  directory: string;
  statePath: string;
  settingsPath: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Malformed Claude AskUserQuestion ${field}`);
  }
  return value.trim();
}

function normalizeClaudeQuestion(
  value: unknown,
  toolUseId: string,
  index: number,
): UserInputQuestion {
  const question = record(value);
  if (!question || !Array.isArray(question.options)) {
    throw new Error("Malformed Claude AskUserQuestion question");
  }
  const options = question.options.map((value) => {
    const option = record(value);
    if (!option) throw new Error("Malformed Claude AskUserQuestion option");
    const label = requiredText(option.label, "option label");
    if (
      option.description !== undefined
      && option.description !== null
      && typeof option.description !== "string"
    ) {
      throw new Error("Malformed Claude AskUserQuestion option description");
    }
    const description = typeof option.description === "string"
      ? option.description.trim()
      : "";
    return { label, ...(description ? { description } : {}) };
  });
  if (question.multiSelect !== undefined && typeof question.multiSelect !== "boolean") {
    throw new Error("Malformed Claude AskUserQuestion multiSelect");
  }
  return {
    id: `${toolUseId}:${index}`,
    header: requiredText(question.header, "header"),
    question: requiredText(question.question, "question text"),
    options,
    multiSelect: question.multiSelect === true,
    allowOther: true,
    secret: false,
  };
}

function claudeQuestionContext(deferred: ClaudeDeferredToolUse): ClaudeQuestionContext {
  const rawQuestions = deferred.input.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error("Malformed Claude AskUserQuestion input");
  }
  const questions = rawQuestions.map((value, index) =>
    normalizeClaudeQuestion(value, deferred.id, index));
  const answerKeys = rawQuestions.map((value) => {
    const key = record(value)?.question;
    if (typeof key !== "string" || !key.trim()) {
      throw new Error("Malformed Claude AskUserQuestion question text");
    }
    return key;
  });
  const prompts = new Set<string>();
  for (const question of questions) {
    if (prompts.has(question.question)) {
      throw new Error("Claude AskUserQuestion contains duplicate question text");
    }
    prompts.add(question.question);
  }
  return {
    request: { requestId: deferred.id, questions },
    updatedInput(response) {
      const answers: Record<string, string> = {};
      for (const [index, question] of questions.entries()) {
        const values = response.answers[question.id];
        if (!values || values.length === 0 || values.some((value) => typeof value !== "string")) {
          throw new Error(`Missing answer for Claude question ${question.id}`);
        }
        if (!question.multiSelect && values.length !== 1) {
          throw new Error(`Claude question ${question.id} accepts one answer`);
        }
        Object.defineProperty(answers, answerKeys[index]!, {
          value: question.multiSelect ? values.join(", ") : values[0] as string,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return { ...deferred.input, questions: rawQuestions, answers };
    },
  };
}

function shellQuote(value: string): string {
  if (process.platform === "win32") return JSON.stringify(value);
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function callerSettings(value: string | undefined, cwd: string): Record<string, unknown> {
  if (!value) return {};
  const trimmed = value.trim();
  let parsed: unknown;
  try {
    parsed = trimmed.startsWith("{")
      ? JSON.parse(trimmed)
      : JSON.parse(readFileSync(isAbsolute(value) ? value : resolvePath(cwd, value), "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read Claude settings: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
  const settings = record(parsed);
  if (!settings) throw new Error("Claude settings must be a JSON object");
  return settings;
}

function createClaudeHookFiles(opts: RunClaudeOptions): ClaudeHookFiles {
  const directory = mkdtempSync(join(tmpdir(), "agent-cli-runner-claude-question-"));
  try {
    chmodSync(directory, 0o700);
    const statePath = join(directory, "state.json");
    const settingsPath = join(directory, "settings.json");
    writeFileSync(statePath, JSON.stringify({ mode: "defer" }), { mode: 0o600 });

    const settings = callerSettings(opts.settings, opts.cwd);
    const existingHooks = settings.hooks === undefined ? {} : record(settings.hooks);
    if (!existingHooks) throw new Error("Claude settings hooks must be an object");
    const preToolUse = existingHooks.PreToolUse === undefined ? [] : existingHooks.PreToolUse;
    if (!Array.isArray(preToolUse)) {
      throw new Error("Claude settings PreToolUse hooks must be an array");
    }
    const hookScript = fileURLToPath(new URL("./claude-question-hook.js", import.meta.url));
    const command = `${shellQuote(process.execPath)} ${shellQuote(hookScript)} ${shellQuote(statePath)}`;
    const merged = {
      ...settings,
      hooks: {
        ...existingHooks,
        PreToolUse: [
          ...preToolUse,
          {
            matcher: "AskUserQuestion",
            hooks: [{ type: "command", command }],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(merged), { mode: 0o600 });
    return { directory, statePath, settingsPath };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function waitForUserInput(
  callback: Promise<UserInputCallbackResult>,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<UserInputCallbackResult> {
  if (signal?.aborted) {
    void callback.catch(() => {});
    return Promise.reject(new AbortError("claude run aborted"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (use: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      use();
    };
    const abort = (): void => finish(() => reject(new AbortError("claude run aborted")));
    signal?.addEventListener("abort", abort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(
        () => finish(() => reject(new TimeoutError(`claude run timed out after ${timeoutMs}ms`))),
        Math.max(0, timeoutMs),
      );
    }
    callback.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/** Spawn a non-interactive Claude Code CLI turn (`claude -p` with stream-json
 * output) and translate its JSONL stream into callbacks plus a final result. */
async function runClaudeProcess(opts: RunClaudeOptions): Promise<ClaudeProcessResult> {
  if (opts.newSessionId && opts.resumeSessionId) {
    throw new Error(
      "newSessionId and resumeSessionId are mutually exclusive — pass one or the other",
    );
  }
  if (opts.isolated && opts.resumeSessionId) {
    throw new Error("isolated Claude runs cannot resume a session");
  }
  if (opts.isolated && opts.permissionMode) {
    throw new Error("isolated Claude runs cannot set a permission mode");
  }
  if (opts.isolated && opts.tools) {
    throw new Error("isolated Claude runs cannot set tools — isolated already disables them all");
  }

  const spawnFn = opts.spawnFn ?? nodeSpawn;
  const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];
  // Claude Code hides AskUserQuestion from plain headless sessions even when
  // --tools names it. The stdio permission bridge makes the interactive tool
  // available; our PreToolUse hook still defers it before any stdio prompt.
  if (opts.onUserInputRequest) {
    args.push("--permission-prompt-tool", "stdio");
  }
  if (opts.isolated) {
    args.push(
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
    );
  }
  // Partial messages roughly double the CLI's stdout, so only ask for them
  // when the host is actually rendering the fragments.
  if (opts.onAssistantTextDelta) {
    args.push("--include-partial-messages");
  }
  if (opts.appendSystemPrompt) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }
  if (opts.permissionMode) {
    args.push("--permission-mode", opts.permissionMode);
  }
  if (opts.disallowedTools && opts.disallowedTools.length > 0) {
    // One space-separated argument: the flag is variadic, and separate
    // arguments would swallow whatever positional followed them.
    args.push("--disallowed-tools", opts.disallowedTools.join(" "));
  }
  // Presence check, not length: [] must reach the CLI as --tools "" (disable
  // all built-ins), never fall back to the full set.
  if (opts.tools) {
    args.push("--tools", opts.tools.join(","));
  }
  if (opts.settingSources) {
    args.push("--setting-sources", opts.settingSources.join(","));
  }
  if (opts.settings) {
    args.push("--settings", opts.settings);
  }
  if (opts.newSessionId) {
    args.push("--session-id", opts.newSessionId);
  } else if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }

  const child = spawnFn(opts.executablePath ?? "claude", args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: filterEnv(opts.env ?? process.env, CLAUDE_STRIPPED_ENV_VARS),
  });
  writePrompt(child, opts.prompt);

  return new Promise<RunResult>((resolve, reject) => {
    let settled = false;
    let sessionId: string | undefined;
    let sessionIdEmitted = false;
    let lastAssistantText: string | undefined;
    let resultText: string | undefined;
    let deferredToolUse: ClaudeDeferredToolUse | undefined;
    let lastAssistantModel: string | undefined;
    let lastMessageUsage: ClaudeUsage | undefined;
    let lastUsage: TokenUsage | undefined;
    const agentToolCallIds = new Set<string>();
    const backgroundAgents = new Map<string, BackgroundAgentInfo>();

    const emitBackgroundAgent = (agent: BackgroundAgentInfo): void => {
      backgroundAgents.set(agent.id, agent);
      try {
        opts.onBackgroundAgentUpdate?.(agent);
      } catch {
        // A host callback must not interrupt the provider stream.
      }
    };

    const emitUsage = (usage: TokenUsage): void => {
      lastUsage = usage;
      opts.onUsage?.(usage);
    };

    const lifecycle = watchLifecycle({
      cli: "claude",
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      kill: (signal) => {
        try {
          child.kill(signal);
        } catch {
          // The process may already have exited.
        }
      },
    });

    const emitSessionId = (id: string): void => {
      sessionId = id;
      if (sessionIdEmitted) return;
      sessionIdEmitted = true;
      opts.onSessionId?.(id);
    };

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: StreamLine;
      try {
        parsed = JSON.parse(trimmed) as StreamLine;
      } catch {
        return;
      }
      // Checked first: with --include-partial-messages these outnumber every
      // other line type by an order of magnitude.
      if (parsed.type === "stream_event") {
        // Subagent prose streams through the parent's stdout tagged with the
        // spawning tool call — it belongs to that agent, not this transcript.
        if (parsed.parent_tool_use_id) return;
        const delta = parsed.event?.type === "content_block_delta"
          ? parsed.event.delta
          : undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          opts.onAssistantTextDelta?.(delta.text);
        }
        return;
      }
      if (parsed.type === "system" && parsed.subtype === "init" && parsed.session_id) {
        emitSessionId(parsed.session_id);
        return;
      }
      if (
        parsed.type === "system"
        && parsed.subtype === "task_started"
        && typeof parsed.task_id === "string"
      ) {
        const isAgent = parsed.task_type === "local_agent"
          || parsed.task_type === "remote_agent"
          || (typeof parsed.tool_use_id === "string" && agentToolCallIds.has(parsed.tool_use_id));
        if (!isAgent) return;
        const now = Date.now();
        emitBackgroundAgent({
          id: parsed.task_id,
          provider: "claude",
          ...(typeof parsed.tool_use_id === "string"
            ? { parentToolCallId: parsed.tool_use_id }
            : {}),
          ...(typeof parsed.description === "string"
            ? { description: parsed.description }
            : {}),
          ...(typeof parsed.task_type === "string" ? { agentType: parsed.task_type } : {}),
          status: "running",
          startedAt: now,
          updatedAt: now,
        });
        return;
      }
      if (
        parsed.type === "system"
        && parsed.subtype === "task_progress"
        && typeof parsed.task_id === "string"
      ) {
        const current = backgroundAgents.get(parsed.task_id);
        if (!current) return;
        const usage = parsed.usage;
        const progress = {
          ...(current.progress ?? {}),
          ...(typeof usage?.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
          ...(typeof usage?.tool_uses === "number" ? { toolUses: usage.tool_uses } : {}),
          ...(typeof usage?.duration_ms === "number" ? { durationMs: usage.duration_ms } : {}),
          ...(typeof parsed.last_tool_name === "string"
            ? { lastToolName: parsed.last_tool_name }
            : {}),
        };
        emitBackgroundAgent({
          ...current,
          ...(typeof parsed.tool_use_id === "string"
            ? { parentToolCallId: parsed.tool_use_id }
            : {}),
          ...(typeof parsed.description === "string"
            ? { description: parsed.description }
            : {}),
          ...(typeof parsed.subagent_type === "string"
            ? { agentType: parsed.subagent_type }
            : {}),
          ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
          ...(Object.keys(progress).length > 0 ? { progress } : {}),
          status: "running",
          updatedAt: Date.now(),
        });
        return;
      }
      if (
        parsed.type === "system"
        && parsed.subtype === "task_updated"
        && typeof parsed.task_id === "string"
      ) {
        const current = backgroundAgents.get(parsed.task_id);
        if (!current || !parsed.patch) return;
        const status = claudeBackgroundAgentStatus(parsed.patch.status) ?? current.status;
        const now = Date.now();
        emitBackgroundAgent({
          ...current,
          ...(typeof parsed.patch.description === "string"
            ? { description: parsed.patch.description }
            : {}),
          ...(typeof parsed.patch.error === "string" ? { error: parsed.patch.error } : {}),
          status,
          updatedAt: now,
          ...((status === "completed" || status === "failed" || status === "interrupted")
            ? {
                endedAt: current.endedAt
                  ?? (typeof parsed.patch.end_time === "number" ? parsed.patch.end_time : now),
              }
            : {}),
        });
        return;
      }
      if (parsed.type === "assistant" && parsed.message?.content) {
        const texts: string[] = [];
        for (const block of parsed.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            texts.push(block.text);
          } else if (block.type === "tool_use" && typeof block.name === "string") {
            if (block.name === "AskUserQuestion" && opts.onUserInputRequest) continue;
            if (
              (block.name === "Agent" || block.name === "Task")
              && typeof block.id === "string"
            ) {
              agentToolCallIds.add(block.id);
            }
            const planItems = claudeTodoPlanItems(block.name, block.input);
            const summary = planItems
              ? planCompletionSummary(planItems)
              : summarizeClaudeTool(block.name, block.input);
            opts.onToolUse?.({
              ...(typeof block.id === "string" ? { callId: block.id } : {}),
              name: block.name,
              ...(summary !== undefined ? { summary } : {}),
              ...(block.input ? { input: block.input } : {}),
              ...(planItems ? { planItems } : {}),
            });
          }
        }
        if (texts.length > 0) {
          const text = texts.join("");
          lastAssistantText = text;
          opts.onAssistantText?.(text);
        }
        const model = parsed.message.model;
        // Track the responding model even on messages without usage, so the
        // result event can attribute usage to it rather than the largest-window
        // model in a multi-model turn.
        if (model) lastAssistantModel = model;
        if (parsed.message.usage) {
          // Live window is a best-effort guess from the model id; the `result`
          // event corrects it with the authoritative modelUsage window.
          lastMessageUsage = parsed.message.usage;
          emitUsage(
            toClaudeUsage(parsed.message.usage, model, contextWindowForModel(model)),
          );
        }
        return;
      }
      if (parsed.type === "user" && parsed.message?.content) {
        for (const block of parsed.message.content) {
          if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
            continue;
          }
          opts.onToolResult?.({
            callId: block.tool_use_id,
            content: block.content,
            ...(typeof block.is_error === "boolean" ? { isError: block.is_error } : {}),
          });
        }
        return;
      }
      if (parsed.type === "result") {
        if (parsed.session_id) emitSessionId(parsed.session_id);
        if (typeof parsed.result === "string") resultText = parsed.result;
        if (
          parsed.stop_reason === "tool_deferred"
          && parsed.deferred_tool_use?.name === "AskUserQuestion"
          && typeof parsed.deferred_tool_use.id === "string"
          && record(parsed.deferred_tool_use.input)
        ) {
          deferredToolUse = {
            id: parsed.deferred_tool_use.id,
            name: "AskUserQuestion",
            input: parsed.deferred_tool_use.input as Record<string, unknown>,
          };
        }
        // The result event's usage sums every request in the turn, so it does
        // not describe context occupancy on a multi-request turn — the last
        // per-message usage does. Take only the authoritative model/window
        // from here, falling back to the summed counts when no message carried
        // usage (then the turn had a single request and they coincide).
        const occupancy = lastMessageUsage ?? parsed.usage;
        if (occupancy) {
          const primary = pickPrimaryModel(parsed.modelUsage, lastAssistantModel);
          const model = primary?.model ?? lastAssistantModel;
          const contextWindow =
            primary?.contextWindow ?? contextWindowForModel(model);
          emitUsage(toClaudeUsage(occupancy, model, contextWindow));
        }
      }
    };

    const splitter = createLineSplitter(handleLine);
    child.stdout?.on("data", (chunk: Buffer | string) => splitter.push(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      opts.onStderr?.(chunk.toString());
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      lifecycle.cleanup();
      reject(isMissingExecutable(err) ? new MissingCliError("claude") : err);
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
      resolve({
        text: (resultText ?? lastAssistantText ?? "").trim(),
        exitCode: code ?? -1,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(lastUsage !== undefined ? { usage: lastUsage } : {}),
        ...(deferredToolUse ? { deferredToolUse } : {}),
      });
    });
  });
}

const MINIMUM_QUESTION_VERSION = [2, 1, 89] as const;
const MAX_QUESTION_DEFERRALS = 64;

function supportsNativeQuestions(version: readonly number[]): boolean {
  for (let index = 0; index < MINIMUM_QUESTION_VERSION.length; index += 1) {
    const actual = version[index] ?? 0;
    const minimum = MINIMUM_QUESTION_VERSION[index]!;
    if (actual !== minimum) return actual > minimum;
  }
  return true;
}

async function assertNativeQuestionSupport(
  opts: RunClaudeOptions,
  timeoutMs: number | undefined,
): Promise<void> {
  const spawnFn = opts.spawnFn ?? nodeSpawn;
  const child = spawnFn(opts.executablePath ?? "claude", ["--version"], {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: filterEnv(opts.env ?? process.env, CLAUDE_STRIPPED_ENV_VARS),
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let output = "";
    const lifecycle = watchLifecycle({
      cli: "claude",
      signal: opts.signal,
      timeoutMs,
      kill: (signal) => {
        try {
          child.kill(signal);
        } catch {
          // The version process may already have exited.
        }
      },
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (output.length < 256) output += chunk.toString().slice(0, 256 - output.length);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      lifecycle.cleanup();
      reject(isMissingExecutable(error) ? new MissingCliError("claude") : error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      lifecycle.cleanup();
      const interruption = lifecycle.interruptionError();
      if (interruption) {
        reject(interruption);
        return;
      }
      const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
      if (code !== 0 || !match) {
        reject(new Error(
          "Could not determine the Claude Code version required for native AskUserQuestion",
        ));
        return;
      }
      const version = match.slice(1, 4).map(Number);
      if (!supportsNativeQuestions(version)) {
        reject(new Error(
          `Native AskUserQuestion requires Claude Code 2.1.89 or newer; found ${match[0]}`,
        ));
        return;
      }
      resolve();
    });
  });
}

/** Run one logical Claude turn. Native questions may stop and resume several
 * `claude -p` processes, but hosts see one callback stream and one result. */
export async function runClaude(opts: RunClaudeOptions): Promise<RunResult> {
  if (opts.isolated && opts.onUserInputRequest) {
    throw new Error("isolated Claude runs cannot request user input");
  }
  const startedAt = Date.now();
  const deadline = opts.timeoutMs === undefined ? undefined : startedAt + opts.timeoutMs;
  let hookFiles: ClaudeHookFiles | undefined;
  const {
    newSessionId: _newSessionId,
    resumeSessionId: _resumeSessionId,
    settings: _settings,
    timeoutMs: _timeoutMs,
    prompt: _prompt,
    onSessionId: _onSessionId,
    ...shared
  } = opts;
  let prompt = opts.prompt;
  let newSessionId = opts.newSessionId;
  let resumeSessionId = opts.resumeSessionId;
  let emittedSessionId: string | undefined;
  let questionDeferrals = 0;
  const remainingTimeout = (): number | undefined => {
    if (deadline === undefined) return undefined;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new TimeoutError(`claude run timed out after ${opts.timeoutMs}ms`);
    return remaining;
  };

  try {
    if (opts.onUserInputRequest) {
      await assertNativeQuestionSupport(opts, remainingTimeout());
      hookFiles = createClaudeHookFiles(opts);
    }
    while (true) {
      const timeoutMs = remainingTimeout();
      const result = await runClaudeProcess({
        ...shared,
        prompt,
        ...(newSessionId ? { newSessionId } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(hookFiles ? { settings: hookFiles.settingsPath } : opts.settings ? { settings: opts.settings } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        onSessionId: (id) => {
          if (emittedSessionId === id) return;
          emittedSessionId = id;
          opts.onSessionId?.(id);
        },
      });
      if (!result.deferredToolUse) {
        const { deferredToolUse: _deferred, ...runResult } = result;
        return runResult;
      }
      if (!opts.onUserInputRequest || !hookFiles) {
        throw new Error("Claude deferred AskUserQuestion without a user-input callback");
      }
      questionDeferrals += 1;
      if (questionDeferrals > MAX_QUESTION_DEFERRALS) {
        throw new Error(`Claude turn exceeded ${MAX_QUESTION_DEFERRALS} deferred questions`);
      }
      const sessionId = result.sessionId ?? emittedSessionId ?? resumeSessionId;
      if (!sessionId) throw new Error("Claude deferred a question without a session ID");
      const context = claudeQuestionContext(result.deferredToolUse);
      const timeoutForInput = remainingTimeout();
      const answer = await waitForUserInput(
        opts.onUserInputRequest(context.request),
        opts.signal,
        timeoutForInput,
      );
      if (isUserInputPause(answer)) {
        return {
          text: result.text,
          exitCode: 0,
          sessionId,
          stopReason: "user_input",
          ...(result.usage ? { usage: result.usage } : {}),
        };
      }
      writeFileSync(hookFiles.statePath, JSON.stringify({
        mode: "answer",
        toolUseId: result.deferredToolUse.id,
        updatedInput: context.updatedInput(answer),
      }), { mode: 0o600 });
      prompt = "";
      newSessionId = undefined;
      resumeSessionId = sessionId;
    }
  } finally {
    if (hookFiles) rmSync(hookFiles.directory, { recursive: true, force: true });
  }
}
