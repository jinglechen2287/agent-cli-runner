import {
  isRecord,
  normalizeSummary,
  planCompletionSummary,
  safeCallback,
  toContextWindow,
  toTokenCount,
} from "./internal.js";
import type {
  AgentCallbacks,
  BackgroundAgentInfo,
  BackgroundAgentStatus,
  ToolPlanItem,
} from "./types.js";
import { contextWindowForModel, type TokenUsage } from "./usage.js";

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
  /** On the `init` line: the session's model, variant marker included. */
  model?: string;
  event?: ClaudeStreamEvent;
  /** Set on lines produced by a background subagent, naming the tool call that
   * spawned it. Null/absent on the parent turn's own output. */
  parent_tool_use_id?: string | null;
  result?: string;
  /** On `result`: set when the turn failed (an error subtype, or an API
   * error the CLI reported as the success subtype's text). */
  is_error?: boolean;
  /** On an error `result`: the CLI's error messages. */
  errors?: unknown;
  /** On `task_notification`: the task's terminal state. */
  status?: string;
  /** On `result` (and a turn's stream frames): the uuid of the user message
   * the turn answers, when the host stamped one. */
  user_message_uuid?: unknown;
  /** On `result`: every stamped user message the turn consumed. */
  user_message_uuids?: unknown;
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

/** Restore the variant marker an assistant message dropped. Claude Code names
 * the qualified model (`claude-opus-4-8[1m]`) once, on the init line, and
 * reports the bare id on every assistant message — and that marker is the only
 * thing that tells a 1M session apart from the 200k default, so guessing the
 * live window from the bare id reads a 1M turn as 200k until the result event
 * corrects it. Only the same base model inherits the marker: a sub-agent or a
 * mid-turn switch keeps its own id. */
function qualifyModel(
  model: string | undefined,
  sessionModel: string | undefined,
): string | undefined {
  if (!model) return sessionModel;
  if (!sessionModel) return model;
  return baseModelId(sessionModel) === baseModelId(model) ? sessionModel : model;
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
    // Exact first: the bare id and its `[1m]` variant can both be listed.
    const base = baseModelId(preferred);
    const match = entries.find(([key]) => key === preferred)
      ?? entries.find(([key]) => baseModelId(key) === base);
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

/** Whether a usage block counts any prompt or output tokens. */
function countsTokens(usage: ClaudeUsage): boolean {
  return (usage.input_tokens ?? 0) > 0
    || (usage.output_tokens ?? 0) > 0
    || (usage.cache_read_input_tokens ?? 0) > 0
    || (usage.cache_creation_input_tokens ?? 0) > 0;
}

function isTerminalTaskStatus(status: string | undefined): boolean {
  return status === "completed"
    || status === "failed"
    || status === "stopped"
    || status === "killed";
}

/** What a Claude turn produced once its `result` arrived (or the stream ended
 * without one). */
export interface ClaudeTurnOutcome {
  /** The result text, else the last parent assistant message, trimmed. */
  text: string;
  sessionId?: string;
  usage?: TokenUsage;
  /** The `result` reported a failed turn. */
  isError: boolean;
  /** The error `result`'s messages, when it carried any. */
  errors: string[];
}

export interface ClaudeTurnTranslator {
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

export interface ClaudeTurnTranslatorOptions {
  /** The uuid stamped on this turn's prompt. With it, a `result` that answers
   * something else — a task the CLI settles on resume, another prompt — is
   * not taken for this turn's. Without it, every `result` is this turn's. */
  promptUuid?: string;
  /** An earlier turn of the same process saw a `result` name its prompt, so
   * one that names none is never this turn's own. */
  cliEchoesPromptUuid?: boolean;
}

/** The prompt uuids a `result` names, or undefined when it names none. */
function namedPromptUuids(parsed: StreamLine): string[] | undefined {
  const named: string[] = [];
  if (typeof parsed.user_message_uuid === "string") named.push(parsed.user_message_uuid);
  if (Array.isArray(parsed.user_message_uuids)) {
    for (const uuid of parsed.user_message_uuids) {
      if (typeof uuid === "string") named.push(uuid);
    }
  }
  return named.length > 0 ? named : undefined;
}

/** Translate one Claude turn's stream-json messages into host callbacks. One
 * translator per turn: session-id deduplication, usage attribution, and task
 * tracking are all scoped to it. */
export function createClaudeTurnTranslator(
  callbacks: AgentCallbacks,
  options: ClaudeTurnTranslatorOptions = {},
): ClaudeTurnTranslator {
  const { promptUuid } = options;
  /** The prompt, then every steer, in the order the CLI received them. */
  const expected: string[] = promptUuid !== undefined ? [promptUuid] : [];
  /** How many of {@link expected} some `result` has answered. A result that
   * names one answers everything sent before it too: a CLI that names only
   * the last message of a batch still covers the batch. */
  let answeredCount = 0;
  let resultSeen = false;
  /** A subagent settled after the turn's result; the CLI's answer to its
   * notification is still to come. */
  let followUpPending = false;
  let echoedPromptUuid = false;
  /** The parent conversation produced output this turn (not a subagent). */
  let outputSeen = false;
  let isError = false;
  let errors: string[] = [];
  let sessionId: string | undefined;
  let sessionIdEmitted = false;
  let lastAssistantText: string | undefined;
  let resultText: string | undefined;
  let lastAssistantModel: string | undefined;
  /** The init line's fully-qualified model id, variant marker included. */
  let sessionModel: string | undefined;
  let lastMessageUsage: ClaudeUsage | undefined;
  let lastUsage: TokenUsage | undefined;
  const agentToolCallIds = new Set<string>();
  const backgroundAgents = new Map<string, BackgroundAgentInfo>();
  const liveTaskIds = new Set<string>();
  const liveAgentTaskIds = new Set<string>();

  const settleTask = (taskId: string): void => {
    liveTaskIds.delete(taskId);
    if (liveAgentTaskIds.delete(taskId) && resultSeen) followUpPending = true;
  };

  /** Whether a `result` answers some other command than this turn's prompt.
   * One that names prompts must name this one. One that names none is, after
   * the turn's own result, the CLI answering a subagent's notification on the
   * turn's behalf; before it, a leftover of some other command. */
  const isForeignResult = (parsed: StreamLine): boolean => {
    if (promptUuid === undefined) return false;
    const named = namedPromptUuids(parsed);
    if (named) return !named.some((uuid) => expected.includes(uuid));
    if (resultSeen) return false;
    if (options.cliEchoesPromptUuid || echoedPromptUuid) return true;
    // A CLI that does not echo: an empty success before the prompt produced
    // anything is the CLI settling a task left over from an earlier process.
    const failed = parsed.is_error === true
      || (typeof parsed.subtype === "string" && parsed.subtype !== "success");
    return !failed && !outputSeen && !parsed.result;
  };
  const emitBackgroundAgent = (agent: BackgroundAgentInfo): void => {
    backgroundAgents.set(agent.id, agent);
    safeCallback(() => callbacks.onBackgroundAgentUpdate?.(agent));
  };

  const emitUsage = (usage: TokenUsage): void => {
    lastUsage = usage;
    safeCallback(() => callbacks.onUsage?.(usage));
  };

  const emitSessionId = (id: string): void => {
    sessionId = id;
    if (sessionIdEmitted) return;
    sessionIdEmitted = true;
    safeCallback(() => callbacks.onSessionId?.(id));
  };

const handle = (message: unknown): void => {
  if (!isRecord(message)) return;
  const parsed = message as StreamLine;
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
        const text = delta.text;
        safeCallback(() => callbacks.onAssistantTextDelta?.(text));
      }
      return;
    }
    if (parsed.type === "system" && parsed.subtype === "init") {
      if (typeof parsed.model === "string" && parsed.model) sessionModel = parsed.model;
      if (parsed.session_id) emitSessionId(parsed.session_id);
      return;
    }
    if (
      parsed.type === "system"
      && parsed.subtype === "task_started"
      && typeof parsed.task_id === "string"
    ) {
      // Every task — a background Bash or Monitor as much as a subagent — is
      // live until it settles, so the host can tell a turn that leaves work
      // running behind it.
      liveTaskIds.add(parsed.task_id);
      const isAgent = parsed.task_type === "local_agent"
        || parsed.task_type === "remote_agent"
        || (typeof parsed.tool_use_id === "string" && agentToolCallIds.has(parsed.tool_use_id));
      if (!isAgent) return;
      liveAgentTaskIds.add(parsed.task_id);
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
        // A trailing progress rollup can arrive after the terminal
        // task_updated; it must not resurrect a finished agent.
        status: current.status === "completed"
          || current.status === "failed"
          || current.status === "interrupted"
          ? current.status
          : "running",
        updatedAt: Date.now(),
      });
      return;
    }
    if (
      parsed.type === "system"
      && parsed.subtype === "task_updated"
      && typeof parsed.task_id === "string"
    ) {
      if (isTerminalTaskStatus(parsed.patch?.status)) settleTask(parsed.task_id);
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
    if (
      parsed.type === "system"
      && parsed.subtype === "task_notification"
      && typeof parsed.task_id === "string"
    ) {
      if (isTerminalTaskStatus(parsed.status)) settleTask(parsed.task_id);
      return;
    }
    if (parsed.type === "assistant" && parsed.message?.content) {
      const texts: string[] = [];
      for (const block of parsed.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (block.type === "tool_use" && typeof block.name === "string") {
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
          const info = {
            ...(typeof block.id === "string" ? { callId: block.id } : {}),
            name: block.name,
            ...(summary !== undefined ? { summary } : {}),
            ...(block.input ? { input: block.input } : {}),
            ...(planItems ? { planItems } : {}),
          };
          safeCallback(() => callbacks.onToolUse?.(info));
        }
      }
      // Subagent prose belongs to the subagent, not this transcript —
      // matching the delta stream, which drops subagent fragments, so
      // fragments always concatenate to the next completed message. Its
      // tool calls above still belong in the parent transcript.
      if (!parsed.parent_tool_use_id) outputSeen = true;
      if (texts.length > 0 && !parsed.parent_tool_use_id) {
        const text = texts.join("");
        lastAssistantText = text;
        safeCallback(() => callbacks.onAssistantText?.(text));
      }
      // A subagent also runs on its own context window; its usage says
      // nothing about how full this turn's is.
      if (parsed.parent_tool_use_id) return;
      const model = qualifyModel(parsed.message.model, sessionModel);
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
        const result = {
          callId: block.tool_use_id,
          content: block.content,
          ...(typeof block.is_error === "boolean" ? { isError: block.is_error } : {}),
        };
        safeCallback(() => callbacks.onToolResult?.(result));
      }
      return;
    }
    if (parsed.type === "result") {
      if (namedPromptUuids(parsed)) echoedPromptUuid = true;
      if (isForeignResult(parsed)) return;
      // A follow-up that answers a notification with nothing to add leaves
      // the turn's last words in place.
      const followUp = resultSeen;
      resultSeen = true;
      followUpPending = false;
      const named = namedPromptUuids(parsed);
      if (named) {
        const last = Math.max(...named.map((uuid) => expected.indexOf(uuid)));
        answeredCount = Math.max(answeredCount, last + 1);
      } else if (options.cliEchoesPromptUuid || echoedPromptUuid) {
        // An echoing CLI names what it answers; this one answers a subagent's
        // notification, which leaves any steer still owed.
        answeredCount = Math.max(answeredCount, 1);
      } else {
        answeredCount = expected.length;
      }
      if (parsed.session_id) emitSessionId(parsed.session_id);
      if (typeof parsed.result === "string" && (!followUp || parsed.result)) {
        resultText = parsed.result;
      }
      isError = parsed.is_error === true
        || (typeof parsed.subtype === "string" && parsed.subtype !== "success");
      errors = Array.isArray(parsed.errors)
        ? parsed.errors.filter((entry): entry is string => typeof entry === "string")
        : [];
      // The result event's usage sums every request in the turn, so it does
      // not describe context occupancy on a multi-request turn — the last
      // per-message usage does. Take only the authoritative model/window
      // from here, falling back to the summed counts when no message carried
      // usage (then the turn had a single request and they coincide).
      // A result with no reply before it — a turn stopped before any output —
      // counts nothing, and reporting that would zero the host's occupancy.
      const occupancy = lastMessageUsage
        ?? (parsed.usage && countsTokens(parsed.usage) ? parsed.usage : undefined);
      if (occupancy) {
        // Without a reply to name the model, the session's own beats the
        // largest-window guess: Claude Code's helper calls (Haiku) appear in
        // modelUsage too, first, and can tie on window.
        const primary = pickPrimaryModel(parsed.modelUsage, lastAssistantModel ?? sessionModel);
        const model = primary?.model ?? lastAssistantModel;
        const contextWindow =
          primary?.contextWindow ?? contextWindowForModel(model);
        emitUsage(toClaudeUsage(occupancy, model, contextWindow));
      }
    }
  };


  const allAnswered = (): boolean => answeredCount >= expected.length;

  return {
    handle,
    expectUserMessage(uuid: string) {
      expected.push(uuid);
    },
    get done() {
      return resultSeen && allAnswered() && liveAgentTaskIds.size === 0 && !followUpPending;
    },
    get resultSeen() {
      return resultSeen;
    },
    get awaitingFollowUp() {
      return resultSeen && liveAgentTaskIds.size === 0 && (followUpPending || !allAnswered());
    },
    get echoedPromptUuid() {
      return echoedPromptUuid;
    },
    liveTaskIds,
    liveAgentTaskIds,
    finish(): ClaudeTurnOutcome {
      // An error result carries its reasons in `errors`, not `result`; the
      // last assistant message would read as if the turn had succeeded.
      const text = isError && errors.length > 0
        ? errors.join("\n")
        : resultText ?? lastAssistantText ?? "";
      return {
        text: text.trim(),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(lastUsage !== undefined ? { usage: lastUsage } : {}),
        isError,
        errors,
      };
    },
  };
}
