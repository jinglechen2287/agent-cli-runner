import { spawn as nodeSpawn } from "node:child_process";
import { MissingCliError } from "./errors.js";
import {
  createLineSplitter,
  filterEnv,
  isMissingExecutable,
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

/** Spawn a non-interactive Claude Code CLI turn (`claude -p` with stream-json
 * output) and translate its JSONL stream into callbacks plus a final result. */
export async function runClaude(opts: RunClaudeOptions): Promise<RunResult> {
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

  const spawnFn = opts.spawnFn ?? nodeSpawn;
  const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];
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
      });
    });
  });
}
