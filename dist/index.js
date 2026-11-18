// src/claude-session.ts
import { spawn as nodeSpawn2 } from "child_process";
import { randomUUID } from "crypto";
import {
  query as sdkQuery
} from "@anthropic-ai/claude-agent-sdk";

// src/internal.ts
function answerMcpElicitation(callback, request, signals) {
  if (!callback) return Promise.resolve({ action: "decline" });
  const controller = new AbortController();
  const fire = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) return Promise.resolve({ action: "cancel" });
    signal.addEventListener("abort", fire, { once: true });
  }
  return new Promise((resolve) => {
    controller.signal.addEventListener("abort", () => resolve({ action: "cancel" }), { once: true });
    Promise.resolve().then(() => callback(request, { signal: controller.signal })).then(resolve, () => resolve({ action: "cancel" }));
  }).finally(() => {
    for (const signal of signals) signal.removeEventListener("abort", fire);
  });
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function optionalString(value) {
  return typeof value === "string" ? value : void 0;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function withoutUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== void 0)
  );
}
function createDeferred() {
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      settled = true;
      resolvePromise(value);
    },
    reject(error) {
      settled = true;
      rejectPromise(error);
    }
  };
}
function raceTimeout(contenders, ms, onTimeout, { unref = false } = {}) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    if (unref) timer.unref?.();
  });
  const race = Promise.race([...contenders, timeout]);
  const clear = () => clearTimeout(timer);
  race.then(clear, clear);
  return race;
}
function safeCallback(use) {
  try {
    const result = use();
    if (result !== null && typeof result === "object" && typeof result.then === "function") {
      void Promise.resolve(result).catch(() => {
      });
    }
  } catch {
  }
}
function planCompletionSummary(planItems2) {
  const completed = planItems2.filter((item) => item.status === "completed").length;
  return `${completed}/${planItems2.length} steps completed`;
}
function normalizePlanStatus(value) {
  if (typeof value !== "string") return void 0;
  const status = value.trim();
  if (!status) return void 0;
  return status.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/\s+/g, "_");
}
function planItem(text2, status) {
  const itemText = normalizeSummary(text2);
  const itemStatus = normalizePlanStatus(status);
  return itemText && itemStatus ? { text: itemText, status: itemStatus } : void 0;
}
function toPlanItems(values, toItem) {
  if (!Array.isArray(values)) return void 0;
  const items = [];
  for (const value of values) {
    const item = isRecord(value) ? toItem(value) : void 0;
    if (!item) return void 0;
    items.push(item);
  }
  return items.length > 0 ? items : void 0;
}
function isTerminalAgentStatus(status) {
  return status === "completed" || status === "failed" || status === "interrupted";
}
function normalizeSummary(value) {
  if (typeof value !== "string") return void 0;
  const summary = value.replace(/\s+/g, " ").trim();
  return summary || void 0;
}
function toTokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
function toContextWindow(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}

// src/claude-mcp-status.ts
var MCP_STATUS_TIMEOUT_MS = 5e3;
var MCP_STATUS_POLL_MS = 2e3;
var MCP_STATUS_POLL_LIMIT_MS = 3e4;
var CLAUDE_MCP_STATUSES = {
  pending: "connecting",
  connected: "connected",
  failed: "failed",
  "needs-auth": "needs-auth",
  disabled: "disabled"
};
function claudeMcpStatuses(servers, known = []) {
  return servers.flatMap((server) => {
    if (!isRecord(server) || typeof server.name !== "string" || typeof server.status !== "string") {
      return [];
    }
    if (!Object.hasOwn(CLAUDE_MCP_STATUSES, server.status)) return [];
    const status = CLAUDE_MCP_STATUSES[server.status];
    if (!status) return [];
    const stated = typeof server.error === "string" && server.error ? server.error : void 0;
    const previous = known.find((entry) => entry.name === server.name && entry.status === status);
    const error = stated ?? previous?.error;
    return [{ name: server.name, status, ...error ? { error } : {} }];
  });
}
function createClaudeMcpStatus(runtime, activeTurn) {
  let mcpStatuses;
  let mcpStatusInFlight = false;
  let mcpPollTimer;
  const emitMcpStatus = () => {
    const callbacks = activeTurn()?.callbacks;
    const snapshot = mcpStatuses;
    if (!callbacks?.onMcpStatus || !snapshot) return;
    safeCallback(() => callbacks.onMcpStatus?.(snapshot.map((status) => ({ ...status }))));
  };
  const updateMcpStatus = (next) => {
    if (JSON.stringify(next) === JSON.stringify(mcpStatuses)) return;
    mcpStatuses = next;
    emitMcpStatus();
  };
  const stopPoll = () => {
    if (mcpPollTimer) clearTimeout(mcpPollTimer);
    mcpPollTimer = void 0;
  };
  const refreshMcpStatus = async () => {
    const turn = activeTurn();
    if (!turn?.callbacks.onMcpStatus || !runtime.mcpServerStatus || mcpStatusInFlight) return;
    mcpStatusInFlight = true;
    try {
      const servers = await raceTimeout(
        [runtime.mcpServerStatus()],
        MCP_STATUS_TIMEOUT_MS,
        () => new Error("timed out"),
        { unref: true }
      );
      if (activeTurn() === turn) updateMcpStatus(claudeMcpStatuses(servers, mcpStatuses));
    } catch {
    } finally {
      mcpStatusInFlight = false;
    }
    const active = activeTurn();
    if (active && active !== turn) {
      void refreshMcpStatus();
      return;
    }
    if (active === turn && Date.now() < turn.mcpPollDeadline && mcpStatuses?.some(({ status }) => status === "connecting")) {
      stopPoll();
      mcpPollTimer = setTimeout(() => void refreshMcpStatus(), MCP_STATUS_POLL_MS);
      mcpPollTimer.unref?.();
    }
  };
  return {
    fromInit(servers) {
      updateMcpStatus(claudeMcpStatuses(servers, mcpStatuses));
      void refreshMcpStatus();
    },
    turnStarted() {
      if (!mcpStatuses) return;
      emitMcpStatus();
      void refreshMcpStatus();
    },
    stopPoll
  };
}

// src/usage.ts
function tokenUsage(counts, model, contextWindow) {
  return {
    contextTokens: counts.contextTokens,
    inputTokens: counts.inputTokens,
    cachedInputTokens: counts.cachedInputTokens,
    outputTokens: counts.outputTokens,
    ...model ? { model } : {},
    ...contextWindow !== void 0 ? { contextWindow } : {}
  };
}
var GPT_5_CONTEXT_WINDOW = 272e3;
var GPT_5_6_CONTEXT_WINDOW = 372e3;
var KNOWN_CONTEXT_WINDOWS = {
  "gpt-5.2": GPT_5_CONTEXT_WINDOW,
  "gpt-5.4": GPT_5_CONTEXT_WINDOW,
  "gpt-5.4-mini": GPT_5_CONTEXT_WINDOW,
  "gpt-5.5": GPT_5_CONTEXT_WINDOW,
  "gpt-5.6-luna": GPT_5_6_CONTEXT_WINDOW,
  "gpt-5.6-sol": GPT_5_6_CONTEXT_WINDOW,
  "gpt-5.6-terra": GPT_5_6_CONTEXT_WINDOW,
  "codex-auto-review": GPT_5_CONTEXT_WINDOW
};
var CLAUDE_DEFAULT_CONTEXT_WINDOW = 2e5;
var CLAUDE_1M_CONTEXT_WINDOW = 1e6;
var CLAUDE_CONTEXT_WINDOWS = {
  "claude-opus-4": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-opus-4-0": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-opus-4-1": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-opus-4-5": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-opus-4-6": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-opus-4-7": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-opus-4-8": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-opus-5": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-opus-5-5": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-sonnet-4": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-sonnet-4-0": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-sonnet-4-5": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-sonnet-4-6": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-sonnet-5": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-sonnet-5-5": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-haiku-4-5": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-haiku-5-5": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-fable-5": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-fable-5-1": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-mythos-5": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-mythos-5-1": CLAUDE_1M_CONTEXT_WINDOW
};
var CLAUDE_MODEL_ID = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/;
function claudeContextWindow(id) {
  if (/\[1m\]|[-_]1m\b/.test(id)) return CLAUDE_1M_CONTEXT_WINDOW;
  const match = CLAUDE_MODEL_ID.exec(id);
  if (!match) {
    return /fable|mythos/.test(id) ? CLAUDE_1M_CONTEXT_WINDOW : CLAUDE_DEFAULT_CONTEXT_WINDOW;
  }
  const [, family, major, minor] = match;
  const canonical = `claude-${family}-${major}${minor !== void 0 ? `-${minor}` : ""}`;
  if (Object.hasOwn(CLAUDE_CONTEXT_WINDOWS, canonical)) {
    return CLAUDE_CONTEXT_WINDOWS[canonical];
  }
  if (family === "fable" || family === "mythos") return CLAUDE_1M_CONTEXT_WINDOW;
  return Number(major) >= 5 ? CLAUDE_1M_CONTEXT_WINDOW : CLAUDE_DEFAULT_CONTEXT_WINDOW;
}
function contextWindowForModel(model) {
  if (!model) return void 0;
  const id = model.trim().toLowerCase();
  if (!id) return void 0;
  if (Object.hasOwn(KNOWN_CONTEXT_WINDOWS, id)) {
    return KNOWN_CONTEXT_WINDOWS[id];
  }
  if (id.includes("claude")) return claudeContextWindow(id);
  if (id.startsWith("gpt-5.6")) return GPT_5_6_CONTEXT_WINDOW;
  if (id.startsWith("gpt-5")) return GPT_5_CONTEXT_WINDOW;
  return void 0;
}

// src/claude-messages.ts
function summarizeClaudeTool(name, input) {
  if (!input) return void 0;
  const str = (key) => normalizeSummary(input[key]);
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
      if (taskId && status) return `Task #${taskId} \xB7 ${status}`;
      return taskId ? `Task #${taskId}` : status;
    }
    case "Skill": {
      const skill = str("skill");
      const skillArgs = str("args");
      if (skill && skillArgs) return `${skill} \xB7 ${skillArgs}`;
      return skill;
    }
    default:
      return void 0;
  }
}
function claudeTodoPlanItems(name, input) {
  if (name !== "TodoWrite" || !input) return void 0;
  return toPlanItems(input.todos, (todo) => planItem(
    normalizeSummary(todo.content) ?? normalizeSummary(todo.activeForm),
    todo.status
  ));
}
var AGENT_TOOL_NAMES = /* @__PURE__ */ new Set(["Agent", "Task"]);
function claudeBackgroundAgentStatus(status) {
  switch (status) {
    case "pending":
    case "running":
    case "completed":
    case "failed":
      return status;
    case "killed":
      return "interrupted";
    default:
      return void 0;
  }
}
function optionalTokenCount(value) {
  const count = toTokenCount(value);
  return count > 0 ? count : void 0;
}
function toClaudeUsage(usage, model, contextWindow) {
  const input = toTokenCount(usage.input_tokens);
  const cacheRead = toTokenCount(usage.cache_read_input_tokens);
  const cacheCreation = toTokenCount(usage.cache_creation_input_tokens);
  return tokenUsage({
    contextTokens: input + cacheRead + cacheCreation,
    inputTokens: input,
    cachedInputTokens: cacheRead,
    outputTokens: toTokenCount(usage.output_tokens)
  }, model, contextWindow);
}
function baseModelId(model) {
  return model.replace(/\[[^\]]*\]$/, "");
}
function qualifyModel(model, sessionModel) {
  if (!model) return sessionModel;
  if (!sessionModel) return model;
  return baseModelId(sessionModel) === baseModelId(model) ? sessionModel : model;
}
function pickPrimaryModel(modelUsage, preferred) {
  if (!modelUsage) return void 0;
  const entries = Object.entries(modelUsage);
  if (entries.length === 0) return void 0;
  if (preferred) {
    const base = baseModelId(preferred);
    const match = entries.find(([key]) => key === preferred) ?? entries.find(([key]) => baseModelId(key) === base);
    if (match) return { model: match[0], contextWindow: toContextWindow(match[1].contextWindow) };
  }
  let best = entries[0];
  for (const entry of entries) {
    if ((toContextWindow(entry[1].contextWindow) ?? 0) > (toContextWindow(best[1].contextWindow) ?? 0)) {
      best = entry;
    }
  }
  return { model: best[0], contextWindow: toContextWindow(best[1].contextWindow) };
}
function countsTokens(usage) {
  return (usage.input_tokens ?? 0) > 0 || (usage.output_tokens ?? 0) > 0 || (usage.cache_read_input_tokens ?? 0) > 0 || (usage.cache_creation_input_tokens ?? 0) > 0;
}
function isTerminalTaskStatus(status) {
  return status === "completed" || status === "failed" || status === "stopped" || status === "killed";
}
function createClaudeSessionState() {
  return { contextWindows: /* @__PURE__ */ new Map() };
}
function knownContextWindow(session, model) {
  return (model !== void 0 ? session.contextWindows.get(model) : void 0) ?? contextWindowForModel(model);
}
function namedPromptUuids(parsed) {
  const named = [];
  if (typeof parsed.user_message_uuid === "string") named.push(parsed.user_message_uuid);
  if (Array.isArray(parsed.user_message_uuids)) {
    for (const uuid of parsed.user_message_uuids) {
      if (typeof uuid === "string") named.push(uuid);
    }
  }
  return named.length > 0 ? named : void 0;
}
function createClaudeTurnTranslator(callbacks, options = {}) {
  const { promptUuid } = options;
  const session = options.session ?? createClaudeSessionState();
  const expected = promptUuid !== void 0 ? [promptUuid] : [];
  let answeredCount = 0;
  let resultSeen = false;
  let followUpPending = false;
  let echoedPromptUuid = false;
  let outputSeen = false;
  let isError = false;
  let errors = [];
  let sessionId;
  let sessionIdEmitted = false;
  let lastAssistantText;
  let resultText;
  let lastAssistantModel;
  let lastMessageUsage;
  let lastUsage;
  let compacted = false;
  const agentToolCallIds = /* @__PURE__ */ new Set();
  const backgroundAgents = /* @__PURE__ */ new Map();
  const liveTaskIds = /* @__PURE__ */ new Set();
  const liveAgentTaskIds = /* @__PURE__ */ new Set();
  const owedTasks = /* @__PURE__ */ new Set();
  const owedRuns = /* @__PURE__ */ new Set();
  let answeringQueued = false;
  const notifiedMidAnswer = /* @__PURE__ */ new Set();
  const settleTask = (taskId) => {
    liveTaskIds.delete(taskId);
    if (liveAgentTaskIds.delete(taskId) && resultSeen) owedTasks.add(taskId);
  };
  const notifyTask = (taskId, runId) => {
    const live = liveAgentTaskIds.has(taskId);
    settleTask(taskId);
    if (!owedTasks.delete(taskId) && !(live && resultSeen)) return;
    if (!runId) {
      followUpPending = true;
      return;
    }
    owedRuns.add(runId);
    if (answeringQueued) notifiedMidAnswer.add(runId);
  };
  const isForeignResult = (parsed) => {
    if (promptUuid === void 0) return false;
    const named = namedPromptUuids(parsed);
    if (named) return !named.some((uuid) => expected.includes(uuid));
    if (resultSeen) return false;
    if (echoesPromptUuid()) return true;
    return !resultFailed(parsed) && !outputSeen && !parsed.result;
  };
  const emitBackgroundAgent = (agent) => {
    backgroundAgents.set(agent.id, agent);
    safeCallback(() => callbacks.onBackgroundAgentUpdate?.(agent));
  };
  const emitUsage = (usage) => {
    lastUsage = usage;
    safeCallback(() => callbacks.onUsage?.(usage));
  };
  const emitSessionId = (id) => {
    sessionId = id;
    if (sessionIdEmitted) return;
    sessionIdEmitted = true;
    safeCallback(() => callbacks.onSessionId?.(id));
  };
  const resultFailed = (parsed) => parsed.is_error === true || typeof parsed.subtype === "string" && parsed.subtype !== "success";
  const echoesPromptUuid = () => options.cliEchoesPromptUuid === true || echoedPromptUuid;
  const handleStreamEvent = (parsed) => {
    if (parsed.parent_tool_use_id) return;
    const delta = parsed.event?.type === "content_block_delta" ? parsed.event.delta : void 0;
    if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
      const text2 = delta.text;
      safeCallback(() => callbacks.onAssistantTextDelta?.(text2));
    }
  };
  const handleCompactBoundary = (parsed) => {
    if (parsed.parent_tool_use_id) return;
    const metadata = isRecord(parsed.compact_metadata) ? parsed.compact_metadata : {};
    const preTokens = optionalTokenCount(metadata.pre_tokens);
    const postTokens = optionalTokenCount(metadata.post_tokens);
    compacted = true;
    outputSeen = true;
    lastMessageUsage = void 0;
    lastUsage = void 0;
    const info = {
      trigger: metadata.trigger === "auto" ? "auto" : "manual",
      ...preTokens !== void 0 ? { preTokens } : {},
      ...postTokens !== void 0 ? { postTokens } : {}
    };
    safeCallback(() => callbacks.onCompaction?.(info));
  };
  const handleInit = (parsed) => {
    if (resultSeen) answeringQueued = true;
    if (typeof parsed.model === "string" && parsed.model) session.model = parsed.model;
    if (parsed.session_id) emitSessionId(parsed.session_id);
  };
  const handleTaskStarted = (parsed, taskId) => {
    liveTaskIds.add(taskId);
    const isAgent = parsed.task_type === "local_agent" || parsed.task_type === "remote_agent" || typeof parsed.tool_use_id === "string" && agentToolCallIds.has(parsed.tool_use_id);
    if (!isAgent) return;
    liveAgentTaskIds.add(taskId);
    const now = Date.now();
    emitBackgroundAgent({
      id: taskId,
      provider: "claude",
      ...withoutUndefined({
        parentToolCallId: optionalString(parsed.tool_use_id),
        description: optionalString(parsed.description),
        agentType: optionalString(parsed.task_type)
      }),
      status: "running",
      startedAt: now,
      updatedAt: now
    });
  };
  const handleTaskProgress = (parsed, taskId) => {
    const current = backgroundAgents.get(taskId);
    if (!current) return;
    const usage = parsed.usage;
    const progress = {
      ...current.progress ?? {},
      ...typeof usage?.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {},
      ...typeof usage?.tool_uses === "number" ? { toolUses: usage.tool_uses } : {},
      ...typeof usage?.duration_ms === "number" ? { durationMs: usage.duration_ms } : {},
      ...typeof parsed.last_tool_name === "string" ? { lastToolName: parsed.last_tool_name } : {}
    };
    emitBackgroundAgent({
      ...current,
      ...withoutUndefined({
        parentToolCallId: optionalString(parsed.tool_use_id),
        description: optionalString(parsed.description),
        agentType: optionalString(parsed.subagent_type),
        summary: optionalString(parsed.summary)
      }),
      ...Object.keys(progress).length > 0 ? { progress } : {},
      // A trailing progress rollup can arrive after the terminal
      // task_updated; it must not resurrect a finished agent.
      status: isTerminalAgentStatus(current.status) ? current.status : "running",
      updatedAt: Date.now()
    });
  };
  const handleTaskUpdated = (parsed, taskId) => {
    const patch = parsed.patch;
    if (isTerminalTaskStatus(patch?.status)) settleTask(taskId);
    const current = backgroundAgents.get(taskId);
    if (!current || !patch) return;
    const status = claudeBackgroundAgentStatus(patch.status) ?? current.status;
    const now = Date.now();
    emitBackgroundAgent({
      ...current,
      ...withoutUndefined({
        description: optionalString(patch.description),
        error: optionalString(patch.error)
      }),
      status,
      updatedAt: now,
      ...isTerminalAgentStatus(status) ? {
        endedAt: current.endedAt ?? (typeof patch.end_time === "number" ? patch.end_time : now)
      } : {}
    });
  };
  const handleSystem = (parsed) => {
    switch (parsed.subtype) {
      case "compact_boundary":
        return handleCompactBoundary(parsed);
      case "init":
        return handleInit(parsed);
    }
    const taskId = parsed.task_id;
    if (typeof taskId !== "string") return;
    switch (parsed.subtype) {
      case "task_started":
        return handleTaskStarted(parsed, taskId);
      case "task_progress":
        return handleTaskProgress(parsed, taskId);
      case "task_updated":
        return handleTaskUpdated(parsed, taskId);
      case "task_notification":
        if (isTerminalTaskStatus(parsed.status)) notifyTask(taskId, optionalString(parsed.run_id));
        return;
    }
  };
  const handleAssistant = (parsed) => {
    const message = parsed.message;
    if (!message?.content) return;
    const texts = [];
    for (const block of message.content) {
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        if (AGENT_TOOL_NAMES.has(block.name) && typeof block.id === "string") {
          agentToolCallIds.add(block.id);
        }
        const planItems2 = claudeTodoPlanItems(block.name, block.input);
        const summary = planItems2 ? planCompletionSummary(planItems2) : summarizeClaudeTool(block.name, block.input);
        const info = {
          ...typeof block.id === "string" ? { callId: block.id } : {},
          name: block.name,
          ...summary !== void 0 ? { summary } : {},
          ...block.input ? { input: block.input } : {},
          ...planItems2 ? { planItems: planItems2 } : {},
          ...parsed.parent_tool_use_id ? { parentToolCallId: parsed.parent_tool_use_id } : {}
        };
        safeCallback(() => callbacks.onToolUse?.(info));
      }
    }
    if (!parsed.parent_tool_use_id) outputSeen = true;
    if (texts.length > 0 && !parsed.parent_tool_use_id) {
      const text2 = texts.join("");
      lastAssistantText = text2;
      safeCallback(() => callbacks.onAssistantText?.(text2));
    }
    if (parsed.parent_tool_use_id) return;
    const model = qualifyModel(message.model, session.model);
    if (model) lastAssistantModel = model;
    if (message.usage) {
      lastMessageUsage = message.usage;
      emitUsage(toClaudeUsage(message.usage, model, knownContextWindow(session, model)));
    }
  };
  const handleUser = (parsed) => {
    const content = parsed.message?.content;
    if (!Array.isArray(content)) return;
    const results = content.filter(
      (block) => block.type === "tool_result" && typeof block.tool_use_id === "string"
    );
    const structured = results.length === 1 && parsed.tool_use_result !== void 0 ? { structured: parsed.tool_use_result } : {};
    for (const block of results) {
      const result = {
        callId: block.tool_use_id,
        content: block.content,
        ...typeof block.is_error === "boolean" ? { isError: block.is_error } : {},
        ...structured,
        ...parsed.parent_tool_use_id ? { parentToolCallId: parsed.parent_tool_use_id } : {}
      };
      safeCallback(() => callbacks.onToolResult?.(result));
    }
  };
  const handleResult = (parsed) => {
    if (namedPromptUuids(parsed)) echoedPromptUuid = true;
    if (isForeignResult(parsed)) return;
    for (const [key, entry] of Object.entries(parsed.modelUsage ?? {})) {
      if (!entry || typeof entry !== "object") continue;
      const window = toContextWindow(entry.contextWindow);
      if (window !== void 0) session.contextWindows.set(key, window);
    }
    const followUp = resultSeen;
    resultSeen = true;
    followUpPending = false;
    answeringQueued = false;
    if (parsed.origin?.kind === "task-notification" && typeof parsed.origin.runId === "string") {
      owedRuns.delete(parsed.origin.runId);
      notifiedMidAnswer.delete(parsed.origin.runId);
    }
    const named = namedPromptUuids(parsed);
    if (named) {
      const last = Math.max(...named.map((uuid) => expected.indexOf(uuid)));
      answeredCount = Math.max(answeredCount, last + 1);
    } else if (echoesPromptUuid()) {
      answeredCount = Math.max(answeredCount, 1);
    } else {
      answeredCount = expected.length;
    }
    if (parsed.session_id) emitSessionId(parsed.session_id);
    if (typeof parsed.result === "string" && (!followUp || parsed.result)) {
      resultText = parsed.result;
    }
    isError = resultFailed(parsed);
    errors = Array.isArray(parsed.errors) ? parsed.errors.filter((entry) => typeof entry === "string") : [];
    const occupancy = lastMessageUsage ?? (!compacted && parsed.usage && countsTokens(parsed.usage) ? parsed.usage : void 0);
    if (occupancy) {
      const primary = pickPrimaryModel(parsed.modelUsage, lastAssistantModel ?? session.model);
      const model = primary?.model ?? lastAssistantModel;
      const contextWindow = primary?.contextWindow ?? knownContextWindow(session, model);
      emitUsage(toClaudeUsage(occupancy, model, contextWindow));
    }
  };
  const handle = (message) => {
    if (!isRecord(message)) return;
    const parsed = message;
    switch (parsed.type) {
      // First: with --include-partial-messages these outnumber every other
      // line type by an order of magnitude.
      case "stream_event":
        return handleStreamEvent(parsed);
      case "system":
        return handleSystem(parsed);
      case "assistant":
        return handleAssistant(parsed);
      case "user":
        return handleUser(parsed);
      case "result":
        return handleResult(parsed);
    }
  };
  const allAnswered = () => answeredCount >= expected.length;
  const agentsSettled = () => resultSeen && liveAgentTaskIds.size === 0;
  const owesFollowUp = () => followUpPending || owedTasks.size > 0 || owedRuns.size > 0 || !allAnswered();
  return {
    handle,
    expectUserMessage(uuid) {
      expected.push(uuid);
    },
    get done() {
      return agentsSettled() && !owesFollowUp();
    },
    get resultSeen() {
      return resultSeen;
    },
    get awaitingFollowUp() {
      return agentsSettled() && owesFollowUp();
    },
    get followUpMayBeAbsorbed() {
      return agentsSettled() && !followUpPending && allAnswered() && !answeringQueued && owedTasks.size === 0 && owedRuns.size > 0 && [...owedRuns].every((runId) => notifiedMidAnswer.has(runId));
    },
    get echoedPromptUuid() {
      return echoedPromptUuid;
    },
    get compacted() {
      return compacted;
    },
    liveTaskIds,
    liveAgentTaskIds,
    finish() {
      const text2 = isError && errors.length > 0 ? errors.join("\n") : resultText ?? lastAssistantText ?? "";
      return {
        text: text2.trim(),
        ...sessionId !== void 0 ? { sessionId } : {},
        ...lastUsage !== void 0 ? { usage: lastUsage } : {},
        isError,
        errors
      };
    }
  };
}

// src/errors.ts
var AbortError = class extends Error {
  name = "AbortError";
  constructor(message = "Aborted") {
    super(message);
  }
};
var TimeoutError = class extends Error {
  name = "TimeoutError";
  constructor(message = "Timed out") {
    super(message);
  }
};
var MissingCliError = class extends Error {
  name = "MissingCliError";
  cli;
  constructor(cli) {
    super(`\`${cli}\` CLI not found. Install it and make sure it is on your PATH.`);
    this.cli = cli;
  }
};
var CodexTurnError = class extends Error {
  name = "CodexTurnError";
  /** Exit code of the Codex process, once known. */
  exitCode;
};
var UnsupportedServerRequestError = class extends Error {
  constructor(method) {
    super(`Unsupported server request: ${method}`);
    this.name = "UnsupportedServerRequestError";
  }
};
var SteerRejectedError = class extends Error {
  name = "SteerRejectedError";
};
function runAborted(cli) {
  return new AbortError(`${cli} run aborted`);
}
function runTimedOut(cli, timeoutMs) {
  return new TimeoutError(`${cli} run timed out after ${timeoutMs}ms`);
}

// src/process.ts
import { execFile, spawn as nodeSpawn } from "child_process";
import { accessSync, constants, statSync } from "fs";
import { delimiter, extname, resolve as resolvePath, win32 } from "path";
import { StringDecoder } from "string_decoder";
var SIGTERM_GRACE_MS = 2e3;
var CLAUDE_STRIPPED_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN"
];
var CODEX_STRIPPED_ENV_VARS = ["CODEX_THREAD_ID"];
function filterEnv(base, stripped) {
  const env = {};
  const normalize = (key) => process.platform === "win32" ? key.toUpperCase() : key;
  const strippedKeys = new Set(stripped.map(normalize));
  for (const [key, value] of Object.entries(base)) {
    if (value !== void 0 && !strippedKeys.has(normalize(key))) env[key] = value;
  }
  return env;
}
function childEnv(cli, base = process.env) {
  return filterEnv(base, cli === "claude" ? CLAUDE_STRIPPED_ENV_VARS : CODEX_STRIPPED_ENV_VARS);
}
function isMissingExecutable(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function spawnCli(options) {
  try {
    const launch = launchCommand(options.command, options.args, options.env, { cwd: options.cwd });
    return options.spawnFn(launch.command, launch.args, {
      ...launch.options,
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
  } catch (error) {
    if (isMissingExecutable(error)) throw new MissingCliError(options.cli);
    throw error;
  }
}
function createLineSplitter(onLine) {
  let buffer = "";
  let draining = false;
  const decoder = createChunkDecoder((text2) => {
    buffer += text2;
    if (draining) return;
    draining = true;
    let start = 0;
    try {
      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n", start)) {
        onLine(buffer.slice(start, newline));
        start = newline + 1;
      }
    } finally {
      draining = false;
      if (start > 0) buffer = buffer.slice(start);
    }
  });
  return {
    push: decoder.push,
    flush() {
      decoder.flush();
      if (buffer) onLine(buffer);
      buffer = "";
    }
  };
}
function createChunkDecoder(onText) {
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk) {
      const text2 = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (text2) onText(text2);
    },
    flush() {
      const rest = decoder.end();
      if (rest) onText(rest);
    }
  };
}
function writePrompt(child, prompt) {
  const stdin = child.stdin;
  if (!stdin) return;
  stdin.on("error", () => {
  });
  stdin.end(prompt);
}
function terminateTree(kill, exited, { graceMs = SIGTERM_GRACE_MS, unref = false } = {}) {
  let killTimer;
  let giveUpTimer;
  const send = (signal) => {
    try {
      kill(signal);
    } catch {
    }
  };
  const gaveUp = new Promise((resolve) => {
    send("SIGTERM");
    killTimer = setTimeout(() => {
      if (exited.settled) return;
      send("SIGKILL");
      giveUpTimer = setTimeout(resolve, graceMs);
      if (unref) giveUpTimer.unref?.();
    }, graceMs);
    if (unref) killTimer.unref?.();
  });
  const stopped = Promise.race([exited.promise, gaveUp]);
  const clear = () => {
    clearTimeout(killTimer);
    clearTimeout(giveUpTimer);
  };
  stopped.then(clear, clear);
  return stopped;
}
function watchLifecycle(opts) {
  let aborted = false;
  let timedOut = false;
  let timeoutTimer;
  const abortHandler = () => {
    if (aborted || timedOut) return;
    aborted = true;
    opts.terminate();
  };
  if (opts.signal) {
    if (opts.signal.aborted) abortHandler();
    else opts.signal.addEventListener("abort", abortHandler, { once: true });
  }
  if (opts.timeoutMs !== void 0) {
    timeoutTimer = setTimeout(() => {
      if (aborted || timedOut) return;
      timedOut = true;
      opts.terminate();
    }, opts.timeoutMs);
  }
  return {
    interruptionError() {
      if (aborted) return runAborted(opts.cli);
      if (timedOut) return runTimedOut(opts.cli, opts.timeoutMs);
      return null;
    },
    cleanup() {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      opts.signal?.removeEventListener("abort", abortHandler);
    }
  };
}
function signalProcessTree(child, signal, killDirect = (direct) => child.kill(direct)) {
  const killDirectSafely = () => {
    try {
      killDirect(signal);
    } catch {
    }
  };
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
    }
  }
  if (child.pid && process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    const killer = nodeSpawn("taskkill", args, {
      stdio: "ignore",
      windowsHide: true
    });
    let fellBack = false;
    const fallback = () => {
      if (fellBack) return;
      fellBack = true;
      killDirectSafely();
    };
    killer.once("error", fallback);
    killer.once("exit", (code) => {
      if (code !== 0) fallback();
    });
    return;
  }
  killDirectSafely();
}
function killTreeOnKill(child) {
  if (process.platform !== "win32") return;
  const killDirect = child.kill.bind(child);
  child.kill = () => {
    signalProcessTree(child, "SIGKILL", (signal) => {
      killDirect(signal);
    });
    return true;
  };
}
function resolveExecutable(name, env, { cwd = process.cwd(), platform = process.platform } = {}) {
  if (platform === "win32") return resolveWindowsExecutable(name, env, cwd);
  const isExecutable = (candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  if (name.includes("/")) {
    const candidate = resolvePath(cwd, name);
    return isExecutable(candidate) ? candidate : void 0;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = resolvePath(cwd, dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return void 0;
}
function windowsEnvValue(env, name) {
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper && value !== void 0) return value;
  }
  return void 0;
}
function resolveWindowsExecutable(name, env, cwd) {
  const extensions = (windowsEnvValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((extension) => extension.toLowerCase());
  const candidates = (base) => [
    ...extname(base) ? [base] : [],
    ...extensions.map((extension) => base + extension)
  ];
  const isFile = (candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  if (/[\\/]/.test(name)) return candidates(resolvePath(cwd, name)).find(isFile);
  for (const entry of (windowsEnvValue(env, "PATH") ?? "").split(win32.delimiter)) {
    const dir = entry.replace(/"/g, "");
    if (!dir) continue;
    const found = candidates(resolvePath(cwd, dir, name)).find(isFile);
    if (found) return found;
  }
  return void 0;
}
var CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;
function escapeBatchArgument(arg) {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META_CHARS, "^$1").replace(CMD_META_CHARS, "^$1");
}
function launchCommand(command, args, env, { cwd = process.cwd(), platform = process.platform } = {}) {
  if (platform !== "win32") return { command, args: [...args], options: {} };
  const resolved = resolveWindowsExecutable(command, env, cwd) ?? command;
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args: [...args], options: {} };
  if (args.some((arg) => /[\r\n]/.test(arg))) {
    throw new Error(`cmd.exe cannot pass a line break in an argument to ${resolved}`);
  }
  const line = [
    win32.normalize(resolved).replace(CMD_META_CHARS, "^$1"),
    ...args.map(escapeBatchArgument)
  ].join(" ");
  return {
    command: windowsEnvValue(env, "ComSpec") ?? windowsEnvValue(process.env, "ComSpec") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true }
  };
}

// src/claude-session.ts
var CLAUDE_INTERRUPT_GRACE_MS = 5e3;
var CLAUDE_FOLLOW_UP_GRACE_MS = 6e4;
var CLAUDE_ABSORBED_FOLLOW_UP_GRACE_MS = 5e3;
var CONTEXT_MEASURE_TIMEOUT_MS = 1e4;
function claudeElicitationRequest(request) {
  const { serverName, message } = request;
  if (request.mode === "url") {
    return request.url ? { serverName, message, mode: "url", url: request.url } : void 0;
  }
  return {
    serverName,
    message,
    mode: "form",
    requestedSchema: request.requestedSchema ?? { type: "object", properties: {} }
  };
}
var TURN_MESSAGE_TYPES = /* @__PURE__ */ new Set(["assistant", "user", "stream_event", "result"]);
var STDERR_TAIL_CHARS = 2e3;
function validateSessionOptions(opts) {
  if (opts.newSessionId && opts.resumeSessionId) {
    throw new Error(
      "newSessionId and resumeSessionId are mutually exclusive \u2014 pass one or the other"
    );
  }
  if (opts.forkSessionId && (opts.newSessionId || opts.resumeSessionId)) {
    throw new Error(
      "forkSessionId is mutually exclusive with newSessionId and resumeSessionId"
    );
  }
  if (opts.isolated && opts.resumeSessionId) {
    throw new Error("isolated Claude runs cannot resume a session");
  }
  if (opts.isolated && opts.permissionMode) {
    throw new Error("isolated Claude runs cannot set a permission mode");
  }
  if (opts.isolated && opts.tools) {
    throw new Error("isolated Claude runs cannot set tools \u2014 isolated already disables them all");
  }
  if (opts.isolated && opts.mcpServers) {
    throw new Error("isolated Claude runs cannot set MCP servers \u2014 isolated already disables MCP");
  }
}
var DENY_EVERY_TOOL = {
  matcher: "*",
  hooks: [
    async () => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "A forked side run may not use tools."
      }
    })
  ]
};
function sdkTools(tools) {
  if (!tools) return void 0;
  if (tools.length === 1 && tools[0] === "default") return { type: "preset", preset: "claude_code" };
  return [...tools];
}
function claudeSessionQueryOptions(opts, sessionId, executablePath, spawnClaudeCodeProcess) {
  const permissionMode = opts.permissionMode === "manual" ? "default" : opts.permissionMode;
  const tools = opts.isolated ? [] : sdkTools(opts.tools);
  return {
    cwd: opts.cwd,
    env: childEnv("claude", opts.env ?? process.env),
    pathToClaudeCodeExecutable: executablePath,
    spawnClaudeCodeProcess,
    // A fork names its own id alongside the session it copies.
    ...opts.forkSessionId ? { resume: opts.forkSessionId, forkSession: true, sessionId } : opts.resumeSessionId ? { resume: opts.resumeSessionId } : { sessionId },
    // Omitting systemPrompt sends an empty one, not Claude Code's.
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...opts.appendSystemPrompt ? { append: opts.appendSystemPrompt } : {}
    },
    includePartialMessages: true,
    ...opts.model ? { model: opts.model } : {},
    ...opts.effort ? { effort: opts.effort } : {},
    ...permissionMode ? { permissionMode } : {},
    ...permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {},
    ...tools !== void 0 ? { tools } : {},
    ...opts.allowedTools?.length ? { allowedTools: [...opts.allowedTools] } : {},
    ...opts.disallowedTools?.length ? { disallowedTools: [...opts.disallowedTools] } : {},
    ...opts.settingSources ? { settingSources: [...opts.settingSources] } : {},
    ...opts.settings !== void 0 ? { settings: opts.settings } : {},
    // An isolated fork has no tools, and refuses any it reaches for anyway; a
    // guarded fork keeps the caller's tools and guard as they are.
    ...opts.forkSessionId && opts.isolated ? { hooks: { ...opts.hooks, PreToolUse: [DENY_EVERY_TOOL, ...opts.hooks?.PreToolUse ?? []] } } : opts.hooks ? { hooks: opts.hooks } : {},
    ...opts.mcpServers ? { mcpServers: { ...opts.mcpServers } } : {},
    ...opts.isolated ? { strictMcpConfig: true, persistSession: false, extraArgs: { "safe-mode": null } } : opts.forkSessionId ? { persistSession: false } : {}
  };
}
function userMessage(prompt, uuid, priority) {
  return {
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
    uuid,
    ...priority ? { priority } : {}
  };
}
function toSpawnedProcess(child) {
  if (!child.stdin || !child.stdout) {
    throw new Error("Claude process was spawned without stdio pipes");
  }
  const stdin = child.stdin;
  const stdout = child.stdout;
  return {
    stdin,
    stdout,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill(signal) {
      signalProcessTree(child, signal);
      return true;
    },
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child)
  };
}
function createInputQueue() {
  const pending = [];
  let ended = false;
  let wake;
  return {
    push(message) {
      pending.push(message);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const next = pending.shift();
          if (next) {
            yield next;
            continue;
          }
          if (ended) return;
          await new Promise((resolve) => {
            wake = resolve;
          });
          wake = void 0;
        }
      }
    }
  };
}
async function createClaudeSession(opts) {
  validateSessionOptions(opts);
  const env = opts.env ?? process.env;
  const executablePath = resolveExecutable(opts.executablePath ?? "claude", env, { cwd: opts.cwd });
  if (!executablePath) throw new MissingCliError("claude");
  const sessionId = opts.resumeSessionId ?? opts.newSessionId ?? randomUUID();
  const spawnFn = opts.spawnFn ?? nodeSpawn2;
  const queryFn = opts.queryFn ?? sdkQuery;
  const interruptGraceMs = opts.interruptGraceMs ?? CLAUDE_INTERRUPT_GRACE_MS;
  const followUpGraceMs = opts.followUpGraceMs ?? CLAUDE_FOLLOW_UP_GRACE_MS;
  const absorbedFollowUpGraceMs = opts.absorbedFollowUpGraceMs ?? CLAUDE_ABSORBED_FOLLOW_UP_GRACE_MS;
  let cliEchoesPromptUuid = false;
  const sessionState = createClaudeSessionState();
  let closed = false;
  let child;
  let childExit;
  let active;
  let stderrTail = "";
  const closeHandlers = /* @__PURE__ */ new Set();
  const input = createInputQueue();
  const spawnClaudeCodeProcess = (spawnOptions) => {
    const spawned = spawnCli({
      cli: "claude",
      spawnFn,
      command: spawnOptions.command,
      args: spawnOptions.args,
      cwd: spawnOptions.cwd ?? opts.cwd,
      env: spawnOptions.env
    });
    const exited = createDeferred();
    child = spawned;
    childExit = exited;
    spawned.once("exit", () => exited.resolve());
    const stderr = createChunkDecoder((text2) => {
      stderrTail = (stderrTail + text2).slice(-STDERR_TAIL_CHARS);
      const callbacks = active?.callbacks;
      safeCallback(() => callbacks?.onStderr?.(text2));
    });
    spawned.stderr?.on("data", (chunk) => stderr.push(chunk));
    spawned.stderr?.on("end", () => stderr.flush());
    spawnOptions.signal.addEventListener("abort", () => signalProcessTree(spawned, "SIGKILL"), {
      once: true
    });
    return toSpawnedProcess(spawned);
  };
  const onElicitation = (request, { signal }) => {
    const turn = active;
    const elicitation = claudeElicitationRequest(request);
    if (!turn || !elicitation) return Promise.resolve({ action: "decline" });
    return answerMcpElicitation(turn.callbacks.onMcpElicitation, elicitation, [
      signal,
      turn.elicitations.signal
    ]);
  };
  const options = {
    ...claudeSessionQueryOptions(opts, sessionId, executablePath, spawnClaudeCodeProcess),
    ...opts.isolated ? {} : { onElicitation }
  };
  const runtime = queryFn({ prompt: input.iterable, options });
  const mcpStatus = createClaudeMcpStatus(runtime, () => active);
  const killTree = () => {
    const current = child;
    const exited = childExit;
    if (!current || !exited || exited.settled) return Promise.resolve();
    return terminateTree((signal) => signalProcessTree(current, signal), exited, { unref: true });
  };
  const interruptionError = (turn) => turn.interruption === "timeout" ? runTimedOut("claude", turn.timeoutMs) : runAborted("claude");
  let closing;
  let closeReason;
  const closeWith = (reason) => {
    if (closing) return closing;
    closed = true;
    closeReason = reason;
    const turn = active;
    active = void 0;
    if (turn) turn.reject(turn.interruption ? interruptionError(turn) : reason);
    for (const handler of closeHandlers) safeCallback(() => handler(reason));
    closeHandlers.clear();
    input.end();
    try {
      runtime.close();
    } catch {
    }
    closing = killTree();
    return closing;
  };
  const measureContext = async () => {
    if (!runtime.getContextUsage) return void 0;
    try {
      const measured = await raceTimeout(
        [runtime.getContextUsage({ detail: "full" })],
        CONTEXT_MEASURE_TIMEOUT_MS,
        () => new Error("timed out"),
        { unref: true }
      );
      const total = measured.totalTokens;
      if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return void 0;
      const model = sessionState.model ?? measured.model;
      const reported = typeof measured.maxTokens === "number" && measured.maxTokens > 0 ? measured.maxTokens : void 0;
      return tokenUsage(
        { contextTokens: Math.round(total), inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        model,
        knownContextWindow(sessionState, model) ?? reported
      );
    } catch {
      return void 0;
    }
  };
  const exitError = (cause) => {
    const detail = cause instanceof Error ? cause.message : "Claude process exited";
    const tail = stderrTail.trim();
    return new Error(tail && !detail.includes(tail) ? `${detail}: ${tail}` : detail);
  };
  const settleTurn = (turn) => {
    if (active !== turn || turn.measuring) return;
    const outcome = turn.translator.finish();
    if (!turn.interruption && turn.compact && !outcome.isError && turn.translator.compacted && !outcome.usage) {
      turn.measuring = true;
      void measureContext().then((usage) => {
        if (active !== turn) return;
        turn.measuring = false;
        if (usage) safeCallback(() => turn.callbacks.onUsage?.(usage));
        finishTurn(turn, outcome, usage);
      });
      return;
    }
    finishTurn(turn, outcome);
  };
  const finishTurn = (turn, outcome, measured) => {
    active = void 0;
    if (turn.interruption) {
      turn.reject(interruptionError(turn));
    } else {
      turn.resolve({
        text: outcome.text,
        exitCode: outcome.isError ? 1 : 0,
        ...withoutUndefined({ sessionId: outcome.sessionId, usage: measured ?? outcome.usage })
      });
    }
    if (turn.interruption) {
      void closeWith(new Error("Claude session closed after an interrupted turn"));
      return;
    }
    if (turn.translator.liveTaskIds.size > 0) {
      void closeWith(new Error("Claude left background tasks running at the end of a turn"));
    }
  };
  void (async () => {
    try {
      for await (const message of runtime) {
        const turn = active;
        if (!turn) {
          const type = isRecord(message) ? message.type : void 0;
          if (typeof type === "string" && TURN_MESSAGE_TYPES.has(type)) {
            void closeWith(new Error("Claude produced output outside a turn"));
            return;
          }
          continue;
        }
        if (isRecord(message) && message.type === "system" && message.subtype === "init" && Array.isArray(message.mcp_servers)) {
          mcpStatus.fromInit(message.mcp_servers);
        }
        turn.translator.handle(message);
        if (turn.translator.echoedPromptUuid) cliEchoesPromptUuid = true;
        if (turn.translator.done) {
          settleTurn(turn);
        } else if (turn.translator.awaitingFollowUp) {
          if (turn.followUpTimer) clearTimeout(turn.followUpTimer);
          turn.followUpTimer = setTimeout(
            () => settleTurn(turn),
            turn.translator.followUpMayBeAbsorbed ? absorbedFollowUpGraceMs : followUpGraceMs
          );
        } else if (turn.followUpTimer) {
          clearTimeout(turn.followUpTimer);
          turn.followUpTimer = void 0;
        }
      }
      void closeWith(exitError());
    } catch (error) {
      void closeWith(exitError(error));
    }
  })();
  const startTurn = (turnOptions, compact) => {
    if (closed) return Promise.reject(closeReason ?? new Error("Claude session is closed"));
    if (active) return Promise.reject(new Error("Claude session already has an active turn"));
    const { prompt, signal, timeoutMs, ...callbacks } = turnOptions;
    if (signal?.aborted) return Promise.reject(runAborted("claude"));
    return new Promise((resolve, reject) => {
      let timeoutTimer;
      let graceTimer;
      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (graceTimer) clearTimeout(graceTimer);
        if (turn.followUpTimer) clearTimeout(turn.followUpTimer);
        signal?.removeEventListener("abort", onAbort);
        mcpStatus.stopPoll();
        turn.elicitations.abort();
      };
      const promptUuid = randomUUID();
      const turn = {
        compact,
        measuring: false,
        translator: createClaudeTurnTranslator(callbacks, {
          promptUuid,
          cliEchoesPromptUuid,
          session: sessionState
        }),
        callbacks,
        interruption: null,
        timeoutMs,
        followUpTimer: void 0,
        elicitations: new AbortController(),
        mcpPollDeadline: Date.now() + MCP_STATUS_POLL_LIMIT_MS,
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        }
      };
      const interrupt = (kind) => {
        if (active !== turn || turn.interruption) return;
        turn.interruption = kind;
        if (turn.measuring) {
          active = void 0;
          turn.reject(interruptionError(turn));
          return;
        }
        runtime.interrupt().catch(() => {
        });
        if (turn.translator.resultSeen) {
          void closeWith(new Error("Claude session closed after an interrupted turn"));
          return;
        }
        graceTimer = setTimeout(() => {
          if (active === turn) void closeWith(new Error("Claude did not stop after an interrupt"));
        }, interruptGraceMs);
      };
      const onAbort = () => interrupt("abort");
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== void 0) {
        timeoutTimer = setTimeout(() => interrupt("timeout"), timeoutMs);
      }
      active = turn;
      input.push(userMessage(prompt, promptUuid));
      mcpStatus.turnStarted();
    });
  };
  return {
    sessionId,
    cwd: opts.cwd,
    get closed() {
      return closed;
    },
    runTurn(turnOptions) {
      return startTurn(turnOptions, false);
    },
    compact({ instructions, ...turnOptions }) {
      const focus = instructions?.trim();
      return startTurn({ ...turnOptions, prompt: focus ? `/compact ${focus}` : "/compact" }, true);
    },
    steer({ prompt }) {
      if (closed) return Promise.reject(new SteerRejectedError("Claude session is closed"));
      const turn = active;
      if (!turn) return Promise.reject(new SteerRejectedError("Claude session has no active turn"));
      if (turn.interruption) {
        return Promise.reject(new SteerRejectedError("Claude turn is being interrupted"));
      }
      if (turn.compact) {
        return Promise.reject(new SteerRejectedError("Claude is compacting the conversation"));
      }
      if (turn.translator.resultSeen) {
        return Promise.reject(new SteerRejectedError("Claude turn is already finishing"));
      }
      const uuid = randomUUID();
      turn.translator.expectUserMessage(uuid);
      input.push(userMessage(prompt, uuid, "next"));
      return Promise.resolve();
    },
    onClose(handler) {
      if (closed) {
        safeCallback(() => handler(closeReason ?? new Error("Claude session is closed")));
        return () => {
        };
      }
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close() {
      return closeWith(new Error("Claude session closed"));
    }
  };
}

// src/run-claude.ts
async function runClaude(opts) {
  const {
    prompt,
    signal,
    timeoutMs,
    cwd,
    executablePath,
    env,
    spawnFn,
    queryFn,
    model,
    effort,
    appendSystemPrompt,
    permissionMode,
    disallowedTools,
    tools,
    allowedTools,
    settingSources,
    settings,
    hooks,
    newSessionId,
    resumeSessionId,
    isolated,
    forkSessionId,
    ...callbacks
  } = opts;
  if (signal?.aborted) throw runAborted("claude");
  const session = await createClaudeSession(withoutUndefined({
    cwd,
    executablePath,
    env,
    spawnFn,
    queryFn,
    model,
    effort,
    appendSystemPrompt,
    permissionMode,
    disallowedTools,
    tools,
    allowedTools,
    settingSources,
    settings,
    hooks,
    newSessionId,
    resumeSessionId,
    isolated,
    forkSessionId
  }));
  try {
    return await session.runTurn({
      prompt,
      ...withoutUndefined({ signal, timeoutMs }),
      ...callbacks
    });
  } finally {
    await session.close();
  }
}

// src/fork.ts
import { deleteSession, forkSession } from "@anthropic-ai/claude-agent-sdk";

// src/codex-client.ts
import { spawn as nodeSpawn3 } from "child_process";

// package.json
var version = "0.5.3";

// src/codex-client.ts
var DEFAULT_REQUEST_TIMEOUT_MS = 1e4;
var CLIENT_INFO = {
  name: "agent_cli_runner",
  title: "Agent CLI Runner",
  version
};
function rpcError(value, fallback) {
  if (!isRecord(value)) return new Error(fallback);
  const message = typeof value.message === "string" ? value.message : fallback;
  const error = new Error(message);
  if (value.code !== void 0) error.code = value.code;
  if (value.data !== void 0) error.data = value.data;
  return error;
}
async function startCodexAppServer(options) {
  const child = spawnCli({
    cli: "codex",
    spawnFn: options.spawnFn ?? nodeSpawn3,
    command: options.executablePath ?? "codex",
    args: ["app-server", "--stdio"],
    cwd: options.cwd,
    env: childEnv("codex", options.env ?? process.env)
  });
  const pending = /* @__PURE__ */ new Map();
  const notificationHandlers = /* @__PURE__ */ new Set();
  let serverRequestRegistration;
  const stderrHandlers = /* @__PURE__ */ new Set();
  const closeHandlers = /* @__PURE__ */ new Set();
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let nextId = 1;
  let closed = false;
  let closeError;
  let terminationRequested = false;
  let stderr = "";
  const whenExited = createDeferred();
  const send = (message) => {
    if (closed) return;
    child.stdin?.write(`${JSON.stringify(message)}
`);
  };
  const rejectPending = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const fail = (error) => {
    if (closed) return;
    closed = true;
    closeError = error;
    rejectPending(error);
    for (const handler of closeHandlers) safeCallback(() => handler(error));
  };
  const respondToServerRequest = async (message) => {
    const id = message.id;
    const method = message.method;
    if (typeof id !== "number" && typeof id !== "string" || typeof method !== "string") return;
    const handler = serverRequestRegistration?.handler;
    if (!handler) {
      send({
        id,
        error: { code: -32601, message: `Unsupported server request: ${method}` }
      });
      return;
    }
    try {
      const result = await handler({ id, method, params: message.params });
      send({ id, result: result ?? null });
    } catch (error) {
      if (error instanceof UnsupportedServerRequestError) {
        send({ id, error: { code: -32601, message: error.message } });
        return;
      }
      send({
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Server request handler failed"
        }
      });
    }
  };
  const handleLine = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.method === "string" && message.id !== void 0) {
      void respondToServerRequest(message);
      return;
    }
    if (typeof message.method === "string") {
      for (const handler of notificationHandlers) {
        safeCallback(() => handler(message.method, message.params));
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error !== void 0) {
      request.reject(rpcError(message.error, "Codex app-server request failed"));
    } else {
      request.resolve(message.result);
    }
  };
  const splitter = createLineSplitter(handleLine);
  child.stdout?.on("data", (chunk) => splitter.push(chunk));
  const stderrDecoder = createChunkDecoder((text2) => {
    stderr = (stderr + text2).slice(-4e3);
    for (const handler of stderrHandlers) safeCallback(() => handler(text2));
  });
  child.stderr?.on("data", (chunk) => stderrDecoder.push(chunk));
  child.stdin?.on("error", (error) => fail(error));
  child.stdout?.on("error", (error) => fail(error));
  child.stderr?.on("error", (error) => fail(error));
  child.on("error", (error) => {
    fail(isMissingExecutable(error) ? new MissingCliError("codex") : error);
  });
  child.on("close", (code) => {
    whenExited.resolve();
    splitter.flush();
    stderrDecoder.flush();
    const detail = stderr.trim();
    fail(new Error(
      `Codex app-server exited${code === null ? "" : ` with code ${code}`}${detail ? `: ${detail}` : ""}`
    ));
  });
  const client = {
    request(method, params = {}, requestTimeoutMs) {
      if (closed) return Promise.reject(new Error("Codex app-server is closed"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new TimeoutError(`Codex app-server request timed out: ${method}`));
        }, requestTimeoutMs ?? timeoutMs);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    },
    notify(method, params) {
      send({ method, params: params ?? {} });
    },
    onNotification(handler) {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    onServerRequest(handler) {
      if (serverRequestRegistration) {
        throw new Error(
          "Codex app-server client already has a server request handler \u2014 remove it first"
        );
      }
      const registration = { handler };
      serverRequestRegistration = registration;
      return () => {
        if (serverRequestRegistration === registration) serverRequestRegistration = void 0;
      };
    },
    onStderr(handler) {
      stderrHandlers.add(handler);
      return () => stderrHandlers.delete(handler);
    },
    onClose(handler) {
      if (closed) {
        safeCallback(() => handler(closeError ?? new Error("Codex app-server is closed")));
        return () => {
        };
      }
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close() {
      if (terminationRequested || whenExited.settled) return;
      terminationRequested = true;
      if (!closed) fail(new Error("Codex app-server was closed"));
      void terminateTree((signal) => signalProcessTree(child, signal), whenExited, { unref: true }).then(whenExited.resolve);
    }
  };
  const abort = () => client.close();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) throw new AbortError();
    await client.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
        ...options.extensions ? { extensions: options.extensions } : {}
      }
    });
    client.notify("initialized", {});
    return { client, whenExited: whenExited.promise };
  } catch (error) {
    client.close();
    throw options.signal?.aborted ? new AbortError() : error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
async function createCodexAppServerClient(options) {
  return (await startCodexAppServer(options)).client;
}

// src/codex-items.ts
function record(value) {
  return isRecord(value) ? value : void 0;
}
function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function property(item, camel, snake) {
  return item[camel] ?? item[snake];
}
function itemType(item) {
  return text(item.type);
}
function webAction(item) {
  return record(item.action);
}
function webActionType(item) {
  const type = text(webAction(item)?.type);
  if (type === "openPage") return "open_page";
  if (type === "findInPage") return "find_in_page";
  return type;
}
function isWebItem(item) {
  const type = itemType(item);
  return type === "webSearch" || type === "web_search";
}
function webUrl(item) {
  return text(webAction(item)?.url) ?? text(item.url);
}
function toolName(item) {
  switch (itemType(item)) {
    case "commandExecution":
    case "command_execution":
      return "Bash";
    case "fileChange":
    case "file_change":
      return "Edit";
    case "mcpToolCall":
    case "mcp_tool_call": {
      const tool = text(item.tool);
      const server = text(item.server);
      return tool && server ? `mcp__${server}__${tool}` : tool ?? "MCP";
    }
    case "dynamicToolCall":
      return text(item.tool) ?? "Tool";
    case "webSearch":
    case "web_search":
      return webActionType(item) === "open_page" || webActionType(item) === "find_in_page" || webActionType(item) === "other" ? "WebFetch" : "WebSearch";
    default:
      return null;
  }
}
function webSearchQuery(item) {
  const direct = normalizeSummary(item.query);
  if (direct) return direct;
  const action = record(item.action);
  const query = normalizeSummary(action?.query);
  if (query) return query;
  if (!Array.isArray(action?.queries)) return void 0;
  for (const candidate of action.queries) {
    const normalized = normalizeSummary(candidate);
    if (normalized) return normalized;
  }
  return void 0;
}
function toolInput(item) {
  const type = itemType(item);
  if (type !== "webSearch" && type !== "web_search") return item;
  const action = webAction(item);
  const actionType = webActionType(item);
  const url = webUrl(item);
  if ((actionType === "open_page" || actionType === "other") && url) {
    const input = { ...item, url };
    delete input.query;
    return input;
  }
  const pattern = text(action?.pattern) ?? text(item.pattern);
  if (actionType === "find_in_page" && (url || pattern)) {
    const input = {
      ...item,
      ...url ? { url } : {},
      ...pattern ? { prompt: `Find ${pattern} in page` } : {}
    };
    delete input.query;
    return input;
  }
  const query = webSearchQuery(item);
  return query ? { ...item, query } : item;
}
function summarizeTool(item) {
  switch (itemType(item)) {
    case "commandExecution":
    case "command_execution":
      return normalizeSummary(item.command);
    case "webSearch":
    case "web_search": {
      const action = webAction(item);
      const actionType = webActionType(item);
      const url = webUrl(item);
      if (actionType === "open_page") return url ?? webSearchQuery(item);
      if (actionType === "find_in_page") {
        const pattern = text(action?.pattern) ?? text(item.pattern);
        if (pattern && url) return `${pattern} \xB7 ${url}`;
        return pattern ?? url ?? webSearchQuery(item);
      }
      if (actionType === "other") return url ?? webSearchQuery(item);
      return webSearchQuery(item);
    }
    case "fileChange":
    case "file_change": {
      if (!Array.isArray(item.changes)) return void 0;
      const paths = item.changes.flatMap((change) => {
        const path = normalizeSummary(record(change)?.path);
        return path ? [path] : [];
      });
      if (paths.length === 1) return paths[0];
      return paths.length > 1 ? `${paths.length} files` : void 0;
    }
    default:
      return void 0;
  }
}
function firstHttpUrl(value) {
  if (!value) return void 0;
  const start = value.search(/https?:\/\//u);
  if (start < 0) return void 0;
  let end = start;
  let parenthesisDepth = 0;
  while (end < value.length) {
    const character = value[end];
    if (!character || /[\s<>"'\]]/u.test(character)) break;
    if (character === "(") {
      parenthesisDepth += 1;
    } else if (character === ")") {
      if (parenthesisDepth === 0) break;
      parenthesisDepth -= 1;
    }
    end += 1;
  }
  return value.slice(start, end).replace(/[.,;:]$/u, "") || void 0;
}
function rawResponseOutputText(item) {
  if (typeof item.output === "string") return text(item.output);
  if (!Array.isArray(item.output)) return void 0;
  const parts = item.output.flatMap((part) => {
    const value = text(record(part)?.text);
    return value ? [value] : [];
  });
  return parts.length > 0 ? parts.join("\n") : void 0;
}
function rawWebOutputUrl(item) {
  const output = rawResponseOutputText(item);
  if (!output) return void 0;
  for (const line of output.split("\n")) {
    const headerStart = line.search(/\(\s*https?:\/\//u);
    if (headerStart < 0 || !line.trimEnd().endsWith(")")) continue;
    const url = firstHttpUrl(line.slice(headerStart + 1));
    if (url) return url;
  }
  return void 0;
}
function singleRawWebCall(item) {
  if (itemType(item) !== "custom_tool_call" || text(item.name) !== "exec") return void 0;
  const input = text(item.input);
  const callId = text(item.call_id) ?? text(item.callId);
  if (!input || !callId) return void 0;
  if (!/^\s*(?:(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)?await\s+tools\.web__run\s*\(/u.test(input)) {
    return void 0;
  }
  const matches = input.match(/tools\.web__run\s*\(/gu);
  if (matches?.length !== 1) return void 0;
  const inputUrl = firstHttpUrl(input);
  return { callId, ...inputUrl ? { inputUrl } : {} };
}
function withWebUrl(item, url) {
  if (!url || webUrl(item)) return item;
  return { ...item, url };
}
function planItems(value) {
  return toPlanItems(value, (step) => planItem(step.step ?? step.text, step.status));
}
function planToolInfo(params, turnId) {
  const items = planItems(params.plan);
  if (!items) return void 0;
  return {
    callId: `${turnId}:plan`,
    name: "TodoWrite",
    summary: planCompletionSummary(items),
    planItems: items,
    input: params
  };
}
function backgroundStatus(value) {
  switch (value) {
    case "pending":
    case "pendingInit":
    case "pending_init":
      return "pending";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "errored":
    case "notFound":
    case "not_found":
      return "failed";
    case "interrupted":
    case "shutdown":
      return "interrupted";
    default:
      return void 0;
  }
}
function toUsage(params, threadId, turnId, model, fallbackWindow) {
  if (params.threadId !== threadId || params.turnId !== turnId) return void 0;
  const reported = record(params.tokenUsage);
  const last = record(reported?.last);
  if (!last) return void 0;
  if (toTokenCount(last.totalTokens) <= 0) return void 0;
  const input = toTokenCount(last.inputTokens);
  return codexTokenUsage({
    // Input side only (cached included), per the TokenUsage contract — not
    // last.totalTokens, which also counts output. Matches the Claude and
    // isolated-exec paths. A compaction sends no request: Codex reports its
    // estimate of the compacted history as a total with no input behind it.
    contextTokens: input > 0 ? input : toTokenCount(last.totalTokens),
    input,
    cached: toTokenCount(last.cachedInputTokens),
    output: toTokenCount(last.outputTokens)
  }, model, toContextWindow(reported?.modelContextWindow) ?? fallbackWindow);
}
function codexTokenUsage(counts, model, contextWindow) {
  return tokenUsage({
    contextTokens: counts.contextTokens,
    inputTokens: Math.max(0, counts.input - counts.cached),
    cachedInputTokens: counts.cached,
    outputTokens: counts.output
  }, model, contextWindow);
}
function threadIdFrom(value) {
  return text(record(record(value)?.thread)?.id);
}
function turnIdFrom(value) {
  return text(record(record(value)?.turn)?.id);
}
function turnStatus(value) {
  return text(record(record(value)?.turn)?.status);
}
function codexMcpStatus(params) {
  const name = text(params.name);
  if (!name) return void 0;
  const error = text(params.error);
  const failed = (status) => ({
    name,
    status,
    ...error ? { error } : {}
  });
  switch (params.status) {
    case "starting":
      return { name, status: "connecting" };
    case "ready":
      return { name, status: "connected" };
    case "failed":
      return failed(params.failureReason === "reauthenticationRequired" ? "needs-auth" : "failed");
    case "cancelled":
      return failed("failed");
    default:
      return void 0;
  }
}
function codexElicitationRequest(params) {
  const serverName = text(params.serverName);
  const message = typeof params.message === "string" ? params.message : void 0;
  if (!serverName || message === void 0) return void 0;
  if (params.mode === "form") {
    const requestedSchema = record(params.requestedSchema);
    return requestedSchema ? { serverName, message, mode: "form", requestedSchema } : void 0;
  }
  if (params.mode === "url") {
    const url = text(params.url);
    return url ? { serverName, message, mode: "url", url } : void 0;
  }
  return void 0;
}
function createWebToolTracker(emit) {
  const pendingWebTools = /* @__PURE__ */ new Map();
  const rawWebCalls = /* @__PURE__ */ new Map();
  const unassignedRawWebCalls = [];
  const assignRawWebCall = (id, pending) => {
    if (pending.rawCallId) return;
    for (let index = unassignedRawWebCalls.length - 1; index >= 0; index -= 1) {
      const call2 = rawWebCalls.get(unassignedRawWebCalls[index]);
      if (!call2 || call2.webItemId) unassignedRawWebCalls.splice(index, 1);
    }
    if (unassignedRawWebCalls.length !== 1) return;
    const callId = unassignedRawWebCalls.shift();
    if (!callId) return;
    const call = rawWebCalls.get(callId);
    if (!call) return;
    call.webItemId = id;
    pending.rawCallId = callId;
  };
  const emitPendingWebTool = (id, force) => {
    const pending = pendingWebTools.get(id);
    if (!pending) return;
    const rawCall = pending.rawCallId ? rawWebCalls.get(pending.rawCallId) : void 0;
    const item = withWebUrl(pending.item, rawCall?.inputUrl ?? rawCall?.outputUrl);
    const needsUrl = toolName(item) === "WebFetch" && !webUrl(item);
    if (!force && needsUrl && rawCall && !rawCall.outputCompleted) return;
    emit.toolUse(id, item);
    if (pending.completed) emit.toolResult(id, item);
    if (pending.completed || force) pendingWebTools.delete(id);
  };
  return {
    onWebItem(item, completed) {
      const id = text(item.id) ?? `${itemType(item)}:web`;
      const pending = pendingWebTools.get(id) ?? {
        item,
        completed: false
      };
      pending.item = item;
      pending.completed = completed;
      assignRawWebCall(id, pending);
      pendingWebTools.set(id, pending);
      if (pending.completed) emitPendingWebTool(id, false);
    },
    onRawResponseItem(item) {
      const rawCall = singleRawWebCall(item);
      if (rawCall) {
        rawWebCalls.set(rawCall.callId, {
          ...rawCall,
          outputCompleted: false
        });
        unassignedRawWebCalls.push(rawCall.callId);
        return;
      }
      if (itemType(item) !== "custom_tool_call_output") return;
      const callId = text(item.call_id) ?? text(item.callId);
      if (!callId) return;
      const call = rawWebCalls.get(callId);
      if (!call) return;
      call.outputCompleted = true;
      const outputUrl = rawWebOutputUrl(item);
      if (outputUrl) call.outputUrl = outputUrl;
      if (call.webItemId) {
        emitPendingWebTool(call.webItemId, false);
      }
    },
    flush() {
      for (const id of [...pendingWebTools.keys()]) emitPendingWebTool(id, true);
    }
  };
}
function createCodexAgentTracker(onUpdate) {
  const backgroundAgents = /* @__PURE__ */ new Map();
  return {
    update(item, occurredAt) {
      const type = itemType(item);
      if (type !== "collabAgentToolCall" && type !== "collab_tool_call") return;
      const tool = text(item.tool);
      const isSpawn = tool === "spawnAgent" || tool === "spawn_agent";
      const states = record(property(item, "agentsStates", "agents_states")) ?? {};
      const rawReceiverIds = property(item, "receiverThreadIds", "receiver_thread_ids");
      const receiverIds = Array.isArray(rawReceiverIds) ? rawReceiverIds.filter((id) => typeof id === "string") : [];
      for (const id of /* @__PURE__ */ new Set([...receiverIds, ...Object.keys(states)])) {
        const current = backgroundAgents.get(id);
        if (!current && !isSpawn) continue;
        const state = record(states[id]);
        const status = backgroundStatus(state?.status) ?? current?.status ?? "pending";
        const message = text(state?.message);
        const itemId = text(item.id);
        const description = current?.description ?? text(item.prompt);
        const agent = {
          ...current ?? {
            id,
            provider: "codex",
            startedAt: occurredAt
          },
          ...!current?.parentToolCallId && itemId ? { parentToolCallId: itemId } : {},
          ...description ? { description } : {},
          status,
          ...message && status === "failed" ? { error: message } : {},
          ...message && status !== "failed" ? { summary: message } : {},
          updatedAt: occurredAt,
          ...isTerminalAgentStatus(status) ? { endedAt: current?.endedAt ?? occurredAt } : {}
        };
        if (status === "failed") delete agent.summary;
        else delete agent.error;
        backgroundAgents.set(id, agent);
        onUpdate(agent);
      }
    }
  };
}

// src/fork.ts
var DEFAULT_FORK_TIMEOUT_MS = 6e4;
async function forkClaudeSession(sessionId, options) {
  const { sessionId: forked } = await forkSession(sessionId, { dir: options.cwd });
  return forked;
}
async function deleteClaudeSession(sessionId, options) {
  await deleteSession(sessionId, { dir: options.cwd });
}
async function forkCodexThread(options) {
  const signal = options.signal;
  if (signal?.aborted) throw new AbortError();
  const timeoutMs = options.timeoutMs ?? DEFAULT_FORK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const client = await createCodexAppServerClient({
    cwd: options.cwd,
    requestTimeoutMs: timeoutMs,
    ...options.executablePath ? { executablePath: options.executablePath } : {},
    ...options.env ? { env: options.env } : {},
    ...options.spawnFn ? { spawnFn: options.spawnFn } : {},
    ...signal ? { signal } : {}
  });
  const abort = () => client.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new AbortError();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new TimeoutError("Codex fork timed out while the app-server started");
    const forked = await client.request(
      "thread/fork",
      { threadId: options.threadId, cwd: options.cwd, ephemeral: false },
      remaining
    );
    const id = threadIdFrom(forked);
    if (!id) throw new Error("Codex answered the fork without a thread id");
    return id;
  } catch (error) {
    if (signal?.aborted) throw new AbortError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    client.close();
  }
}

// src/run-codex.ts
import { spawn } from "child_process";

// src/codex-turn.ts
var TURN_START_TIMEOUT_MS = 6e4;
var MAX_PRE_ACK_NOTIFICATIONS = 1e4;
var CODEX_FORK_CONFIG = {
  web_search: "disabled",
  features: {
    multi_agent: false,
    multi_agent_v2: false,
    goals: false,
    shell_tool: false,
    unified_exec: false,
    apps: false,
    image_generation: false,
    view_image: false,
    sleep_tool: false,
    browser_use: false,
    computer_use: false
  }
};
var FORK_ALLOWED_ITEMS = /* @__PURE__ */ new Set([
  "userMessage",
  "user_message",
  "agentMessage",
  "agent_message",
  "reasoning",
  "plan",
  "contextCompaction"
]);
function requestCodexThread(client, opts) {
  const forkParams = (threadId, config) => ({
    threadId,
    cwd: opts.cwd,
    ...opts.model ? { model: opts.model } : {},
    ...opts.developerInstructions ? { developerInstructions: opts.developerInstructions } : {},
    ephemeral: true,
    // Ephemeral forks of paginated threads must skip hydrating history.
    excludeTurns: true,
    sandbox: "read-only",
    approvalPolicy: "never",
    experimentalRawEvents: true,
    ...config ? { config } : {}
  });
  if (opts.forkSessionId && !opts.isolated) {
    return client.request("thread/fork", forkParams(opts.forkSessionId, opts.forkConfig));
  }
  if (opts.forkSessionId) {
    const forkSessionId = opts.forkSessionId;
    return client.request("config/read", { cwd: opts.cwd }).then((read) => client.request(
      "thread/fork",
      forkParams(forkSessionId, {
        ...CODEX_FORK_CONFIG,
        mcp_servers: Object.fromEntries(
          Object.keys(record(record(record(read)?.config)?.mcp_servers) ?? {}).map((name) => [name, { enabled: false }])
        )
      })
    ));
  }
  const params = {
    cwd: opts.cwd,
    experimentalRawEvents: true,
    ...opts.model ? { model: opts.model } : {},
    ...opts.developerInstructions ? { developerInstructions: opts.developerInstructions } : {},
    ...opts.dangerouslyBypassApprovalsAndSandbox ? { approvalPolicy: "never", sandbox: "danger-full-access" } : {},
    ...opts.config ? { config: opts.config } : {}
  };
  return opts.resumeSessionId ? client.request("thread/resume", { threadId: opts.resumeSessionId, ...params }) : client.request("thread/start", {
    ...params,
    ...opts.threadSource ? { threadSource: opts.threadSource } : {}
  });
}
function openedCodexThread(value, fallbackModel) {
  const threadId = threadIdFrom(value);
  if (!threadId) throw new CodexTurnError("Codex app-server did not return a thread ID");
  const model = text(record(value)?.model) ?? fallbackModel;
  return { threadId, ...model ? { model } : {} };
}
async function runCodexAppServerTurn(opts, {
  client,
  thread: openedThread,
  ownsClient: ownedClient,
  retireClientOnUnackedStart,
  continuity,
  start
}) {
  if (opts.signal?.aborted) {
    if (ownedClient) client.close();
    throw runAborted("codex");
  }
  const isPreviousTurn = (turnId2) => continuity?.previousTurnIds?.has(turnId2) ?? false;
  let threadId = openedThread?.threadId ?? opts.resumeSessionId;
  let turnId;
  let turnStartSent = false;
  let ackReceived = false;
  const preAckNotifications = [];
  let pendingTurnError;
  const resolvePendingTurnError = () => {
    if (!pendingTurnError || !turnId) return;
    const held = pendingTurnError;
    pendingTurnError = void 0;
    if (held.turnId !== turnId) return;
    webTools.flush();
    settleError(held.error);
  };
  const matchTurn = (eventTurnId) => {
    if (!turnStartSent || !eventTurnId) return void 0;
    if (isPreviousTurn(eventTurnId)) return void 0;
    if (turnId && eventTurnId !== turnId) return void 0;
    if (!turnId) {
      turnId = eventTurnId;
      turnLatched.resolve();
      resolvePendingTurnError();
    }
    return eventTurnId;
  };
  const turnScoped = (params) => params.threadId === threadId ? matchTurn(text(params.turnId)) : void 0;
  const turnLatched = createDeferred();
  let resolvedModel = opts.model ?? openedThread?.model;
  let finalText = "";
  let latestUsage;
  let settled = false;
  let interruption;
  let timeout;
  const emittedTools = /* @__PURE__ */ new Set();
  const completion = createDeferred();
  void completion.promise.catch(() => {
  });
  const lifecycle = createDeferred();
  const lifecycleFailure = lifecycle.promise;
  void lifecycleFailure.catch(() => {
  });
  const failLifecycle = (error) => {
    if (lifecycle.settled) return;
    lifecycle.reject(error);
  };
  const raceLifecycle = (operation) => Promise.race([operation, lifecycleFailure]);
  const turnKnown = createDeferred();
  const steer = async (prompt) => {
    if (settled || interruption) throw new SteerRejectedError("Codex turn is already finishing");
    try {
      const known = await Promise.race([
        turnKnown.promise,
        completion.promise.then(() => {
          throw new SteerRejectedError("Codex turn ended before it could be steered");
        }),
        lifecycleFailure
      ]);
      if (!known) throw new SteerRejectedError("Codex turn ended before it could be steered");
    } catch (error) {
      if (error instanceof SteerRejectedError) throw error;
      throw new SteerRejectedError(`Codex turn ended before it could be steered: ${errorMessage(error)}`);
    }
    if (settled || interruption || !threadId || !turnId) {
      throw new SteerRejectedError("Codex turn is already finishing");
    }
    try {
      await client.request("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text: prompt, text_elements: [] }]
      });
    } catch (error) {
      throw new SteerRejectedError(`Codex refused the steer: ${errorMessage(error)}`);
    }
  };
  continuity?.onSteerable?.(steer);
  const settleOk = () => {
    if (settled) return;
    settled = true;
    completion.resolve();
  };
  const settleError = (error) => {
    if (settled) return;
    settled = true;
    completion.reject(error);
  };
  const sendInterrupt = () => threadId && turnId ? client.request("turn/interrupt", { threadId, turnId }).catch(() => {
  }) : Promise.resolve();
  const requestInterrupt = () => {
    const stopped = interruption;
    if (!stopped || !threadId || !turnId) return;
    void sendInterrupt().finally(() => failLifecycle(stopped));
  };
  const refuseForkedTool = (params) => {
    if (!turnScoped(params)) return false;
    const item = record(params.item);
    const type = item ? text(item.type) : void 0;
    if (!item || !type || FORK_ALLOWED_ITEMS.has(type)) return false;
    const name = toolName(item) ?? type;
    void sendInterrupt();
    settleError(new CodexTurnError(`A forked side run tried to use ${name}`));
    return true;
  };
  const interrupt = (error) => {
    if (interruption || settled) return;
    interruption = error;
    if (threadId && turnId) requestInterrupt();
    else failLifecycle(error);
  };
  const abortHandler = () => interrupt(runAborted("codex"));
  if (opts.signal) {
    if (opts.signal.aborted) abortHandler();
    else opts.signal.addEventListener("abort", abortHandler, { once: true });
  }
  let runDeadline;
  if (opts.timeoutMs !== void 0) {
    runDeadline = Date.now() + opts.timeoutMs;
    timeout = setTimeout(
      () => interrupt(runTimedOut("codex", opts.timeoutMs)),
      opts.timeoutMs
    );
  }
  const emitToolUse = (id, item) => {
    if (emittedTools.has(id)) return;
    const name = toolName(item);
    if (!name) return;
    emittedTools.add(id);
    const summary = summarizeTool(item);
    safeCallback(() => opts.onToolUse?.({
      callId: id,
      name,
      ...summary ? { summary } : {},
      input: toolInput(item)
    }));
  };
  const emitToolResult = (id, item) => {
    const exitCode = item.exitCode;
    const status = text(item.status);
    safeCallback(() => opts.onToolResult?.({
      callId: id,
      content: item,
      ...typeof exitCode === "number" && exitCode !== 0 || status === "failed" ? { isError: true } : {}
    }));
  };
  const webTools = createWebToolTracker({ toolUse: emitToolUse, toolResult: emitToolResult });
  const agents = createCodexAgentTracker((agent) => {
    safeCallback(() => opts.onBackgroundAgentUpdate?.(agent));
  });
  const handleItem = (method, params) => {
    if (!turnScoped(params)) return;
    const item = record(params.item);
    if (!item) return;
    const occurredAt = typeof params.startedAtMs === "number" ? params.startedAtMs : typeof params.completedAtMs === "number" ? params.completedAtMs : Date.now();
    agents.update(item, occurredAt);
    if (itemType(item) === "contextCompaction") {
      if (method === "item/completed") {
        const info = { trigger: start === "compact" ? "manual" : "auto" };
        safeCallback(() => opts.onCompaction?.(info));
      }
      return;
    }
    if (method === "item/completed" && itemType(item) === "agentMessage") {
      const message = text(item.text);
      if (message) {
        finalText = message;
        safeCallback(() => opts.onAssistantText?.(message));
      }
      return;
    }
    if (isWebItem(item)) {
      webTools.onWebItem(item, method === "item/completed");
      return;
    }
    const name = toolName(item);
    if (!name) return;
    const id = text(item.id) ?? `${itemType(item)}:${name}`;
    emitToolUse(id, item);
    if (method === "item/completed") emitToolResult(id, item);
  };
  const dispatchNotification = (method, params) => {
    if (method === "turn/started" && params.threadId === threadId) {
      matchTurn(text(record(params.turn)?.id));
      if (interruption) requestInterrupt();
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      if (opts.forkSessionId && opts.isolated && method === "item/started" && refuseForkedTool(params)) return;
      handleItem(method, params);
      return;
    }
    if (method === "item/agentMessage/delta") {
      if (!turnScoped(params)) return;
      const chunk = typeof params.delta === "string" ? params.delta : "";
      if (chunk) safeCallback(() => opts.onAssistantTextDelta?.(chunk));
      return;
    }
    if (method === "rawResponseItem/completed") {
      if (!turnScoped(params)) return;
      const item = record(params.item);
      if (item) webTools.onRawResponseItem(item);
      return;
    }
    if (method === "turn/plan/updated") {
      const eventTurnId = turnScoped(params);
      if (!eventTurnId) return;
      const info = planToolInfo(params, eventTurnId);
      if (info) safeCallback(() => opts.onToolUse?.(info));
      return;
    }
    if (method === "thread/tokenUsage/updated" && threadId && turnId) {
      const usage = toUsage(params, threadId, turnId, resolvedModel, opts.contextWindow);
      if (!usage) return;
      latestUsage = usage;
      safeCallback(() => opts.onUsage?.(usage));
      return;
    }
    if (method === "error" && params.threadId === threadId) {
      if (params.willRetry === true) return;
      const errorTurnId = text(params.turnId);
      const message2 = text(record(params.error)?.message) ?? "Codex turn failed";
      if (errorTurnId) {
        if (!turnStartSent || isPreviousTurn(errorTurnId)) return;
        if (!turnId) {
          pendingTurnError = {
            turnId: errorTurnId,
            error: new CodexTurnError(`Codex error: ${message2}`)
          };
          return;
        }
        if (errorTurnId !== turnId) return;
      }
      webTools.flush();
      settleError(new CodexTurnError(`Codex error: ${message2}`));
      return;
    }
    if (method !== "turn/completed" || params.threadId !== threadId) return;
    if (!matchTurn(text(record(params.turn)?.id))) return;
    webTools.flush();
    if (interruption) {
      failLifecycle(interruption);
      return;
    }
    const status = text(record(params.turn)?.status);
    if (status === "completed") {
      settleOk();
      return;
    }
    const message = text(record(record(params.turn)?.error)?.message) ?? `Codex turn ${status ?? "failed"}`;
    settleError(new CodexTurnError(message));
  };
  const removeNotification = client.onNotification((method, rawParams) => {
    const params = record(rawParams);
    if (!params) return;
    const untaggedFatalError = method === "error" && params.willRetry !== true && !text(params.turnId);
    if (turnStartSent && !ackReceived && method !== "turn/started" && !untaggedFatalError && params.threadId === threadId) {
      if (preAckNotifications.length >= MAX_PRE_ACK_NOTIFICATIONS) {
        preAckNotifications.length = 0;
        settleError(new CodexTurnError(
          "Codex app-server flooded events without acknowledging turn/start"
        ));
        return;
      }
      preAckNotifications.push({ method, params });
      return;
    }
    dispatchNotification(method, params);
  });
  const removeClose = client.onClose((error) => settleError(error));
  const removeStderr = client.onStderr((chunk) => safeCallback(() => opts.onStderr?.(chunk)));
  try {
    const thread = openedThread ?? openedCodexThread(
      await raceLifecycle(requestCodexThread(client, opts)),
      resolvedModel
    );
    threadId = thread.threadId;
    if (!openedThread) resolvedModel = thread.model;
    safeCallback(() => opts.onSessionId?.(thread.threadId));
    if (interruption) throw interruption;
    const input = [
      { type: "text", text: opts.prompt, text_elements: [] },
      ...(opts.imagePaths ?? []).map((path) => ({ type: "localImage", path }))
    ];
    const turnStartTimeoutMs = runDeadline === void 0 ? TURN_START_TIMEOUT_MS : Math.max(1, Math.min(TURN_START_TIMEOUT_MS, runDeadline - Date.now()));
    let turnResult;
    turnStartSent = true;
    safeCallback(() => continuity?.onTurnStartSent?.());
    try {
      const startDeadline = Date.now() + turnStartTimeoutMs;
      turnResult = await Promise.race([
        start === "compact" ? client.request("thread/compact/start", { threadId }, turnStartTimeoutMs) : client.request("turn/start", {
          threadId,
          input,
          cwd: opts.turnCwd ?? opts.cwd,
          ...opts.model ? { model: opts.model } : {},
          ...opts.reasoningEffort ? { effort: opts.reasoningEffort } : {},
          ...opts.serviceTier !== void 0 ? { serviceTier: opts.serviceTier } : {},
          ...opts.sandboxPolicy ? { sandboxPolicy: opts.sandboxPolicy } : {}
        }, turnStartTimeoutMs),
        completion.promise.then(() => {
          throw new CodexTurnError("Codex turn settled before turn/start was acknowledged");
        }),
        lifecycleFailure
      ]);
      if (start === "compact") {
        ackReceived = true;
        for (const entry of preAckNotifications.splice(0)) {
          dispatchNotification(entry.method, entry.params);
        }
        if (!turnId) {
          await raceTimeout(
            [
              turnLatched.promise,
              completion.promise.then(() => {
                throw new CodexTurnError("Codex compaction settled before it started");
              }),
              lifecycleFailure
            ],
            Math.max(1, startDeadline - Date.now()),
            () => new TimeoutError("Codex app-server did not start the compaction")
          );
        }
      }
    } catch (error) {
      if ((error instanceof TimeoutError || error instanceof AbortError) && threadId) {
        if (!interruption) void sendInterrupt();
        if (retireClientOnUnackedStart) client.close();
      }
      throw error;
    }
    turnId = turnIdFrom(turnResult) ?? turnId;
    ackReceived = true;
    for (const entry of preAckNotifications.splice(0)) {
      dispatchNotification(entry.method, entry.params);
    }
    if (!turnId) throw new CodexTurnError("Codex app-server did not return a turn ID");
    turnKnown.resolve(true);
    resolvePendingTurnError();
    if (interruption) requestInterrupt();
    const ackStatus = turnStatus(turnResult);
    const ackTerminal = ackStatus !== void 0 && ackStatus !== "completed" && ackStatus !== "inProgress" && ackStatus !== "in_progress";
    let exitCode = 0;
    if (ackTerminal && !settled) {
      settled = true;
      exitCode = 1;
    } else {
      await raceLifecycle(completion.promise);
      if (ackTerminal) exitCode = 1;
    }
    return {
      text: finalText.trim(),
      exitCode,
      sessionId: thread.threadId,
      ...latestUsage ? { usage: latestUsage } : {}
    };
  } finally {
    continuity?.onSteerable?.(null);
    turnKnown.resolve(false);
    if (timeout) clearTimeout(timeout);
    webTools.flush();
    opts.signal?.removeEventListener("abort", abortHandler);
    removeNotification();
    removeClose();
    removeStderr();
    const finishedTurnId = turnId;
    if (finishedTurnId) safeCallback(() => continuity?.onTurnId?.(finishedTurnId));
    if (ownedClient) client.close();
  }
}

// src/codex-app-server.ts
var ARCHIVE_TIMEOUT_MS = 2e3;
var FORM_INPUT_EXTENSION = "openai/standard-form-input";
async function createCodexAppServerSession(options) {
  const { client, whenExited } = await startCodexAppServer({
    cwd: options.cwd,
    ...withoutUndefined({
      executablePath: options.executablePath || void 0,
      env: options.env,
      spawnFn: options.spawnFn,
      requestTimeoutMs: options.requestTimeoutMs
    }),
    extensions: { [FORM_INPUT_EXTENSION]: {} }
  });
  let activeTurn;
  let threadId;
  const previousTurnIds = /* @__PURE__ */ new Set();
  const openElicitations = /* @__PURE__ */ new Map();
  const mcpStatuses = /* @__PURE__ */ new Map();
  const earlyStatus = [];
  const emitMcpStatus = () => {
    const callbacks = activeTurn?.callbacks;
    if (!callbacks?.onMcpStatus || mcpStatuses.size === 0) return;
    const snapshot = [...mcpStatuses.values()].map((status) => ({ ...status }));
    safeCallback(() => callbacks.onMcpStatus?.(snapshot));
  };
  const applyMcpStatus = (params) => {
    const tagged = text(params.threadId);
    if (tagged && tagged !== threadId) return false;
    const status = codexMcpStatus(params);
    if (!status) return false;
    const previous = mcpStatuses.get(status.name);
    if (previous && JSON.stringify(previous) === JSON.stringify(status)) return false;
    mcpStatuses.set(status.name, status);
    return true;
  };
  client.onNotification((method, rawParams) => {
    const params = record(rawParams);
    if (!params) return;
    if (method === "serverRequest/resolved") {
      if (params.threadId !== threadId) return;
      const requestId = params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        openElicitations.get(requestId)?.abort();
      }
      return;
    }
    if (method !== "mcpServer/startupStatus/updated") return;
    if (threadId === void 0) {
      earlyStatus.push(params);
      return;
    }
    if (applyMcpStatus(params)) emitMcpStatus();
  });
  client.onServerRequest(async (request) => {
    if (request.method !== "mcpServer/elicitation/request") {
      throw new UnsupportedServerRequestError(request.method);
    }
    const params = record(request.params);
    const turn = activeTurn;
    const stale = typeof params?.turnId === "string" && previousTurnIds.has(params.turnId);
    const elicitation = params && params.threadId === threadId && turn && !stale ? codexElicitationRequest(params) : void 0;
    if (!turn || !elicitation) return { action: "decline" };
    const resolved = new AbortController();
    openElicitations.set(request.id, resolved);
    try {
      return await answerMcpElicitation(turn.callbacks.onMcpElicitation, elicitation, [
        turn.elicitations.signal,
        resolved.signal
      ]);
    } finally {
      openElicitations.delete(request.id);
    }
  });
  let opened;
  try {
    opened = openedCodexThread(
      await requestCodexThread(client, { ...options, threadSource: "user" }),
      options.model
    );
  } catch (error) {
    client.close();
    throw error;
  }
  threadId = opened.threadId;
  for (const params of earlyStatus.splice(0)) applyMcpStatus(params);
  let closed = false;
  let running = false;
  let steerRunning = null;
  let closePromise;
  let exited = false;
  let turnStarted = false;
  client.onClose(() => {
    if (!closed) exited = true;
    closed = true;
    activeTurn?.elicitations.abort();
  });
  const archives = () => !!options.archive && turnStarted;
  const archiveThread = async () => {
    const failed = (error) => safeCallback(() => options.onArchiveError?.(
      opened.threadId,
      error instanceof Error ? error : new Error(String(error))
    ));
    if (exited) return failed(new Error("Codex app-server exited before the thread was archived"));
    try {
      await client.request("thread/archive", { threadId: opened.threadId }, options.archiveTimeoutMs ?? ARCHIVE_TIMEOUT_MS);
    } catch (error) {
      failed(error);
    }
  };
  const run = async (turnOptions, start) => {
    if (closed) throw new Error("Codex app-server session is closed");
    if (running) throw new Error("Codex app-server session already has an active turn");
    running = true;
    const turn = { callbacks: turnOptions, elicitations: new AbortController() };
    activeTurn = turn;
    emitMcpStatus();
    try {
      return await runCodexAppServerTurn({
        ...turnOptions,
        cwd: options.cwd,
        ...withoutUndefined({
          executablePath: options.executablePath || void 0,
          env: options.env,
          spawnFn: options.spawnFn,
          dangerouslyBypassApprovalsAndSandbox: options.dangerouslyBypassApprovalsAndSandbox,
          developerInstructions: options.developerInstructions || void 0
        })
      }, {
        client,
        thread: opened,
        ownsClient: false,
        retireClientOnUnackedStart: true,
        start,
        continuity: {
          previousTurnIds,
          onTurnId: (turnId) => {
            previousTurnIds.add(turnId);
          },
          onTurnStartSent: () => {
            turnStarted = true;
          },
          // A compaction takes no more input.
          ...start === "turn" ? {
            onSteerable: (steer) => {
              steerRunning = steer;
            }
          } : {}
        }
      });
    } finally {
      running = false;
      steerRunning = null;
      activeTurn = void 0;
      turn.elicitations.abort();
    }
  };
  return {
    threadId: opened.threadId,
    cwd: options.cwd,
    get closed() {
      return closed;
    },
    runTurn(turnOptions) {
      return run(turnOptions, "turn");
    },
    compact(compactOptions) {
      return run({ ...compactOptions, prompt: "" }, "compact");
    },
    async steer({ prompt }) {
      if (closed) throw new SteerRejectedError("Codex app-server session is closed");
      if (!steerRunning) throw new SteerRejectedError("Codex app-server session has no active turn");
      return steerRunning(prompt);
    },
    onClose(handler) {
      return client.onClose(handler);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      const exit = () => {
        client.close();
        return whenExited;
      };
      closePromise = archives() ? Promise.resolve().then(archiveThread).then(exit) : exit();
      return closePromise;
    }
  };
}
async function runCodexAppServer(opts) {
  if (opts.signal?.aborted) throw runAborted("codex");
  const ownedClient = !opts.appServerClient;
  const client = opts.appServerClient ?? await createCodexAppServerClient({
    cwd: opts.cwd,
    ...withoutUndefined({
      executablePath: opts.executablePath || void 0,
      env: opts.env,
      spawnFn: opts.spawnFn
    })
  });
  return runCodexAppServerTurn(opts, {
    client,
    ownsClient: ownedClient,
    retireClientOnUnackedStart: ownedClient,
    start: "turn"
  });
}

// src/run-codex.ts
function buildIsolatedArgs(opts) {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only"
  ];
  if (opts.model !== void 0) args.push("--model", opts.model);
  if (opts.developerInstructions !== void 0) {
    args.push("-c", `developer_instructions=${JSON.stringify(opts.developerInstructions)}`);
  }
  if (opts.reasoningEffort !== void 0) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(opts.reasoningEffort)}`);
  }
  for (const path of opts.imagePaths ?? []) args.push("-i", path);
  args.push("-");
  return args;
}
function isExecPlanItem(item) {
  return item.type === "todo_list" || item.type === "plan_update";
}
function execToolName(item) {
  return isExecPlanItem(item) ? "TodoWrite" : toolName(item);
}
function execPlanItems(item) {
  return toPlanItems(Array.isArray(item.items) ? item.items : item.plan, (entry) => planItem(
    normalizeSummary(entry.text) ?? normalizeSummary(entry.step),
    typeof entry.completed === "boolean" ? entry.completed ? "completed" : "pending" : entry.status
  ));
}
function execToolSummary(item, planItems2) {
  if (isExecPlanItem(item) && planItems2) return planCompletionSummary(planItems2);
  return summarizeTool(item);
}
function execUsage(usage, opts) {
  const input = toTokenCount(usage.input_tokens);
  const cached = toTokenCount(usage.cached_input_tokens);
  const output = toTokenCount(usage.output_tokens);
  if (input + output <= 0) return void 0;
  return codexTokenUsage(
    // Input side only (cached included), per the TokenUsage contract — not
    // app-server's totalTokens, which also counts output.
    { contextTokens: input, input, cached, output },
    opts.model,
    opts.contextWindow ?? contextWindowForModel(opts.model)
  );
}
function errorDetail(event) {
  if (typeof event.message === "string") return event.message;
  if (typeof event.error === "string") return event.error;
  if (isRecord(event.error) && typeof event.error.message === "string") return event.error.message;
  return void 0;
}
function execFatalError(event) {
  if (event.type !== "error" && event.type !== "turn.failed") return void 0;
  const detail = errorDetail(event);
  return new CodexTurnError(detail ? `Codex error: ${detail}` : "Codex error");
}
async function runIsolatedCodex(opts) {
  const child = spawnCli({
    cli: "codex",
    spawnFn: opts.spawnFn ?? spawn,
    command: opts.executablePath ?? "codex",
    args: buildIsolatedArgs(opts),
    cwd: opts.cwd,
    env: childEnv("codex", opts.env ?? process.env)
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let sessionId;
    let finalText = "";
    let latestUsage;
    let fatalError;
    const emittedTools = /* @__PURE__ */ new Set();
    const ended = createDeferred();
    const lifecycle = watchLifecycle({
      cli: "codex",
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      terminate: () => void terminateTree((signal) => signalProcessTree(child, signal), ended)
    });
    const handleLine = (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      fatalError ??= execFatalError(event);
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        const threadId = event.thread_id;
        sessionId = threadId;
        safeCallback(() => opts.onSessionId?.(threadId));
        return;
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        const message = event.item.text;
        finalText = message;
        safeCallback(() => opts.onAssistantText?.(message));
        return;
      }
      if (event.type === "turn.completed") {
        fatalError = void 0;
        const usage = isRecord(event.usage) ? execUsage(event.usage, opts) : void 0;
        if (usage) {
          latestUsage = usage;
          safeCallback(() => opts.onUsage?.(usage));
        }
        return;
      }
      if (event.type !== "item.started" && event.type !== "item.completed") return;
      const item = event.item;
      if (!item) return;
      const name = execToolName(item);
      if (!name) return;
      const id = typeof item.id === "string" ? item.id : `${String(item.type)}:${name}`;
      if (!emittedTools.has(id)) {
        emittedTools.add(id);
        const planItems2 = execPlanItems(item);
        const summary = execToolSummary(item, planItems2);
        safeCallback(() => opts.onToolUse?.({
          callId: id,
          name,
          ...summary ? { summary } : {},
          ...planItems2 ? { planItems: planItems2 } : {},
          input: toolInput(item)
        }));
      }
      if (event.type === "item.completed") {
        safeCallback(() => opts.onToolResult?.({ callId: id, content: item }));
      }
    };
    const splitter = createLineSplitter(handleLine);
    child.stdout?.on("data", (chunk) => splitter.push(chunk));
    const stderrDecoder = createChunkDecoder(
      (text2) => safeCallback(() => opts.onStderr?.(text2))
    );
    child.stderr?.on("data", (chunk) => stderrDecoder.push(chunk));
    child.on("error", (error) => {
      ended.resolve();
      if (settled) return;
      settled = true;
      lifecycle.cleanup();
      reject(isMissingExecutable(error) ? new MissingCliError("codex") : error);
    });
    child.on("close", (code) => {
      ended.resolve();
      if (settled) return;
      settled = true;
      splitter.flush();
      stderrDecoder.flush();
      lifecycle.cleanup();
      const interruption = lifecycle.interruptionError();
      if (interruption) {
        reject(interruption);
        return;
      }
      if (fatalError) {
        fatalError.exitCode = code ?? -1;
        reject(fatalError);
        return;
      }
      resolve({
        text: finalText.trim(),
        exitCode: code ?? -1,
        ...sessionId ? { sessionId } : {},
        ...latestUsage ? { usage: latestUsage } : {}
      });
    });
    writePrompt(child, opts.prompt);
  });
}
async function runCodex(opts) {
  if (opts.forkConfig && (!opts.forkSessionId || opts.isolated)) {
    throw new Error("only a guarded fork can take fork config");
  }
  if (opts.forkSessionId) {
    validateForkedRun(opts);
    return runCodexAppServer(opts);
  }
  if (opts.isolated) {
    validateIsolatedRun(opts);
    return runIsolatedCodex(opts);
  }
  validateAppServerRun(opts);
  return opts.appServerSession ? opts.appServerSession.runTurn(opts) : runCodexAppServer(opts);
}
function validateAppServerRun(opts) {
  if (opts.appServerClient && opts.appServerSession) {
    throw new Error("Codex runs cannot use both appServerClient and appServerSession");
  }
  if (!opts.appServerSession) return;
  if (opts.resumeSessionId) {
    throw new Error("Session-backed Codex runs cannot resume another session");
  }
  if (opts.developerInstructions !== void 0 || opts.dangerouslyBypassApprovalsAndSandbox !== void 0 || opts.env !== void 0 || opts.executablePath !== void 0 || opts.spawnFn !== void 0) {
    throw new Error("Session-backed Codex runs cannot override thread or client options");
  }
  if (opts.cwd !== opts.appServerSession.cwd) {
    throw new Error("Codex run cwd must match the app-server session cwd");
  }
}
function validateIsolatedRun(opts) {
  if (opts.appServerSession || opts.appServerClient) {
    throw new Error("isolated Codex runs cannot reuse app-server state");
  }
  if (opts.resumeSessionId) throw new Error("isolated Codex runs cannot resume a session");
  if (opts.dangerouslyBypassApprovalsAndSandbox) {
    throw new Error("isolated Codex runs cannot bypass approvals and sandboxing");
  }
  if (opts.sandboxPolicy) {
    throw new Error("isolated Codex runs cannot override the sandbox policy");
  }
  if (opts.turnCwd !== void 0) {
    throw new Error("isolated Codex runs cannot set a turn cwd");
  }
  if (opts.serviceTier !== void 0) {
    throw new Error("isolated Codex runs cannot set a service tier \u2014 codex exec has no equivalent");
  }
}
function validateForkedRun(opts) {
  if (opts.appServerSession || opts.appServerClient) {
    throw new Error("forked Codex runs cannot reuse app-server state");
  }
  if (opts.resumeSessionId) {
    throw new Error("forkSessionId and resumeSessionId are mutually exclusive");
  }
  if (opts.dangerouslyBypassApprovalsAndSandbox) {
    throw new Error("forked Codex runs cannot bypass approvals and sandboxing");
  }
  if (opts.isolated && opts.sandboxPolicy) {
    throw new Error("forked Codex runs cannot override the sandbox policy");
  }
  if (opts.sandboxPolicy && opts.sandboxPolicy.type !== "readOnly") {
    throw new Error("forked Codex runs keep a read-only sandbox");
  }
  if (opts.turnCwd !== void 0) {
    throw new Error("forked Codex runs cannot set a turn cwd");
  }
}

// src/model-catalog.ts
import { execFile as execFile2 } from "child_process";
var MAX_CODEX_MODEL_PAGES = 50;
async function collectCodexModels(requestPage) {
  const models = [];
  let cursor;
  for (let page = 0; page < MAX_CODEX_MODEL_PAGES; page += 1) {
    const response = await requestPage(cursor ?? void 0);
    if (Array.isArray(response.data)) models.push(...response.data);
    cursor = response.nextCursor;
    if (!cursor) break;
  }
  return models;
}
var CLAUDE_FALLBACK_ALIASES = ["opus", "sonnet", "haiku"];
var CLAUDE_FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
function effortLabel(value) {
  if (value === "xhigh") return "Extra High";
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}
function optionBlock(help, option) {
  const start = help.indexOf(option);
  if (start < 0) return "";
  const remainder = help.slice(start);
  const nextOption = remainder.slice(option.length).search(/\n\s{2}--[a-z]/i);
  return nextOption < 0 ? remainder : remainder.slice(0, option.length + nextOption);
}
function uniqueValues(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
function parseClaudeCliHelp(help) {
  const modelHelp = optionBlock(help, "--model <model>");
  const aliasHelp = modelHelp.split(/\bor\s+a\s+model(?:'s)?\b/i)[0] ?? "";
  const aliases = uniqueValues(
    [...aliasHelp.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? "")
  ).filter((alias) => /^[a-z0-9][a-z0-9._[\]-]*$/i.test(alias));
  const effortHelp = optionBlock(help, "--effort <level>");
  const effortList = effortHelp.match(/\(([^)]+)\)/)?.[1] ?? "";
  const efforts = uniqueValues(effortList.split(","));
  return { aliases, efforts };
}
function readClaudeCliCapabilities(executablePath, cwd) {
  const env = childEnv("claude");
  return new Promise((resolve, reject) => {
    const launch = launchCommand(executablePath, ["--help"], env, { cwd });
    const child = execFile2(
      launch.command,
      launch.args,
      {
        ...launch.options,
        cwd,
        timeout: 5e3,
        maxBuffer: 1e6,
        env
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(parseClaudeCliHelp(`${stdout}
${stderr}`));
      }
    );
    killTreeOnKill(child);
  });
}
function claudeModels(capabilities, defaultEffort) {
  const aliases = capabilities.aliases.length > 0 ? capabilities.aliases : CLAUDE_FALLBACK_ALIASES;
  const discoveredEfforts = capabilities.efforts.length > 0 ? capabilities.efforts : CLAUDE_FALLBACK_EFFORTS;
  const efforts = uniqueValues([...discoveredEfforts, ...defaultEffort ? [defaultEffort] : []]).map((effort) => ({ id: effort, label: effortLabel(effort) }));
  return [
    {
      id: "default",
      label: "Default",
      description: "Use the model selected by Claude Code and your account",
      efforts,
      serviceTiers: [],
      defaultEffort: defaultEffort ?? null,
      isDefault: true
    },
    ...aliases.filter((alias) => alias !== "default").map((alias) => ({
      id: alias,
      label: effortLabel(alias),
      description: `Latest model exposed by Claude Code's ${alias} alias`,
      efforts,
      serviceTiers: [],
      defaultEffort: defaultEffort ?? null,
      isDefault: false
    }))
  ];
}
async function listCodexModels(executablePath, cwd) {
  const client = await createCodexAppServerClient({ executablePath, cwd });
  try {
    return await collectCodexModels(
      async (cursor) => client.request("model/list", cursor ? { cursor } : {})
    );
  } finally {
    client.close();
  }
}
function createModelCatalogService(config = {}, deps = {}) {
  const discoverCodex = deps.listCodexModels ?? listCodexModels;
  const discoverClaude = deps.getClaudeCapabilities ?? readClaudeCliCapabilities;
  const now = deps.now ?? (() => /* @__PURE__ */ new Date());
  const hostDefaultEffort = config.defaultEffort?.trim() || void 0;
  return {
    async getCatalog(provider, cwd) {
      if (provider === "claude") {
        let capabilities;
        let source2 = "claude-cli";
        try {
          capabilities = await discoverClaude(config.claudePath ?? "claude", cwd);
        } catch {
          source2 = "claude-fallback";
          capabilities = {
            aliases: [...CLAUDE_FALLBACK_ALIASES],
            efforts: [...CLAUDE_FALLBACK_EFFORTS]
          };
        }
        const models = claudeModels(capabilities, hostDefaultEffort);
        return {
          provider,
          source: source2,
          fetchedAt: now().toISOString(),
          supportsCustomModel: true,
          models: models.map((model) => ({
            ...model,
            efforts: model.efforts.map((effort) => ({ ...effort }))
          }))
        };
      }
      const configuredModel = config.codexModel?.trim() || void 0;
      let source = "codex-app-server";
      let discovered;
      try {
        discovered = await discoverCodex(config.codexPath ?? "codex", cwd);
      } catch (error) {
        if (!configuredModel) throw error;
        source = "codex-config";
        discovered = [];
      }
      const visible = discovered.filter((model) => typeof model.model === "string").map((model) => ({ ...model, model: model.model.trim() })).filter((model) => !model.hidden && model.model);
      if (configuredModel && !visible.some((model) => model.model === configuredModel)) {
        visible.unshift({
          model: configuredModel,
          displayName: configuredModel,
          description: config.configuredModelDescription ?? "Configured model",
          isDefault: true,
          ...hostDefaultEffort ? {
            defaultReasoningEffort: hostDefaultEffort,
            supportedReasoningEfforts: [{ reasoningEffort: hostDefaultEffort }]
          } : {}
        });
      }
      return {
        provider,
        source,
        fetchedAt: now().toISOString(),
        supportsCustomModel: false,
        models: visible.map((model) => {
          const providerDefaultEffort = model.defaultReasoningEffort?.trim() || void 0;
          const defaultEffort = hostDefaultEffort ?? providerDefaultEffort ?? null;
          const efforts = uniqueValues([
            ...(model.supportedReasoningEfforts ?? []).map(({ reasoningEffort }) => reasoningEffort),
            ...providerDefaultEffort ? [providerDefaultEffort] : [],
            ...defaultEffort ? [defaultEffort] : []
          ]).map((reasoningEffort) => ({
            id: reasoningEffort,
            label: effortLabel(reasoningEffort)
          }));
          return {
            id: model.model,
            label: model.displayName?.trim() || model.model,
            ...model.description?.trim() ? { description: model.description.trim() } : {},
            efforts,
            serviceTiers: (model.serviceTiers ?? []).map((tier) => ({ ...tier })),
            defaultEffort,
            isDefault: configuredModel ? model.model === configuredModel : model.isDefault === true
          };
        })
      };
    },
    validateSelection(catalog, input) {
      const model = input.model?.trim() || null;
      const option = model ? catalog.models.find((candidate) => candidate.id === model) : catalog.models.find((candidate) => candidate.isDefault) ?? catalog.models[0];
      if (model && !option && !catalog.supportsCustomModel) {
        throw new Error(`Model is not available: ${model}`);
      }
      const defaultOption = catalog.models.find((candidate) => candidate.isDefault) ?? catalog.models[0];
      const requestedEffort = input.effort === void 0 ? (option ?? defaultOption)?.defaultEffort ?? null : input.effort?.trim() || null;
      const supportedEfforts = option?.efforts.map((candidate) => candidate.id) ?? catalog.models.find((candidate) => candidate.isDefault)?.efforts.map((candidate) => candidate.id) ?? CLAUDE_FALLBACK_EFFORTS;
      if (requestedEffort && supportedEfforts.length > 0 && !new Set(supportedEfforts).has(requestedEffort)) {
        throw new Error(`${model ?? "Default model"} does not support effort ${requestedEffort}`);
      }
      const requestedServiceTier = input.serviceTier?.trim() || null;
      const supportedServiceTiers = option?.serviceTiers.map((candidate) => candidate.id) ?? [];
      if (requestedServiceTier && !new Set(supportedServiceTiers).has(requestedServiceTier)) {
        throw new Error(
          `${model ?? "Default model"} does not support service tier ${requestedServiceTier}`
        );
      }
      return { model, effort: requestedEffort, serviceTier: requestedServiceTier };
    }
  };
}

// src/provider-updates.ts
import { execFile as execFile3 } from "child_process";
var CHECK_TIMEOUT_MS = 5e3;
var CODEX_DOCTOR_TIMEOUT_MS = 3e4;
var APPLY_TIMEOUT_MS = 10 * 60 * 1e3;
var CLAUDE_RELEASE_BASE_URL = "https://downloads.claude.ai/claude-code-releases";
function defaultRunCommand(executable, args, options) {
  return new Promise((resolve, reject) => {
    const launch = launchCommand(executable, args, options.env);
    const child = execFile3(
      launch.command,
      launch.args,
      {
        ...launch.options,
        env: options.env,
        timeout: options.timeoutMs,
        // SIGKILL, not the default SIGTERM: the timeout is a hard ceiling,
        // and an installer that traps SIGTERM would otherwise keep the
        // callback (and apply()'s promise) pending forever.
        killSignal: "SIGKILL",
        maxBuffer: 1e6,
        encoding: "utf8"
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        if (typeof error.code === "number" && !error.killed) {
          resolve({ stdout, stderr, exitCode: error.code });
          return;
        }
        reject(Object.assign(error, { stdout, stderr }));
      }
    );
    killTreeOnKill(child);
  });
}
async function defaultFetchText(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "text/plain" }
    });
    if (!response.ok) {
      throw new Error(`Provider update check returned HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}
function parseVersion(value) {
  const match = value.match(
    /(?:^|[^\d])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?=$|[^0-9A-Za-z.+-])/
  );
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4]?.split(".") ?? [];
  return {
    major,
    minor,
    patch,
    prerelease,
    version: `${major}.${minor}.${patch}${prerelease.length > 0 ? `-${prerelease.join(".")}` : ""}`
  };
}
function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === void 0) return -1;
    if (rightPart === void 0) return 1;
    if (leftPart === rightPart) continue;
    const leftIsNumber = /^\d+$/.test(leftPart);
    const rightIsNumber = /^\d+$/.test(rightPart);
    if (leftIsNumber && rightIsNumber) {
      const normalizedLeft = leftPart.replace(/^0+(?=\d)/, "");
      const normalizedRight = rightPart.replace(/^0+(?=\d)/, "");
      if (normalizedLeft === normalizedRight) continue;
      if (normalizedLeft.length !== normalizedRight.length) {
        return normalizedLeft.length < normalizedRight.length ? -1 : 1;
      }
      return normalizedLeft < normalizedRight ? -1 : 1;
    }
    if (leftIsNumber) return -1;
    if (rightIsNumber) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}
function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}
function formatTimeout(timeoutMs) {
  if (timeoutMs % 6e4 === 0) {
    const minutes = timeoutMs / 6e4;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = timeoutMs / 1e3;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
function isTimeoutError(error) {
  if (!(error instanceof Error)) return false;
  const candidate = error;
  if (candidate.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return false;
  return candidate.killed === true || candidate.code === "ETIMEDOUT";
}
function partialOutput(error) {
  if (!(error instanceof Error)) return "";
  const { stdout, stderr } = error;
  return [stdout, stderr].filter((stream) => typeof stream === "string" && stream !== "").join("\n");
}
function unknownStatus(provider, checkedAt, reason, installedVersion = null) {
  return {
    provider,
    state: "unknown",
    installedVersion,
    latestVersion: null,
    channel: null,
    checkedAt,
    reason
  };
}
function statusFromVersions(input) {
  return {
    provider: input.provider,
    state: compareVersions(input.installed, input.latest) < 0 ? "update_available" : "current",
    installedVersion: input.installed.version,
    latestVersion: input.latest.version,
    channel: input.channel,
    checkedAt: input.checkedAt,
    reason: null
  };
}
function parseClaudeDoctor(output) {
  const installMethod = output.match(/^Config install method:\s*(\S+)\s*$/im)?.[1]?.toLowerCase();
  if (!installMethod) return null;
  const rawChannel = output.match(/^Auto-update channel:\s*(\S+)\s*$/im)?.[1]?.toLowerCase();
  const channel = rawChannel === "stable" || rawChannel === "latest" ? rawChannel : null;
  return { installMethod, channel };
}
function parseCodexLatestVersion(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.checks)) return null;
  const updateCheck = parsed.checks["updates.status"];
  if (!isRecord(updateCheck) || !isRecord(updateCheck.details)) return null;
  const latest = updateCheck.details["latest version"];
  return typeof latest === "string" ? parseVersion(latest) : null;
}
function createProviderUpdateService(config = {}, deps = {}) {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const fetchText = deps.fetchText ?? defaultFetchText;
  const now = deps.now ?? (() => /* @__PURE__ */ new Date());
  const baseEnv = config.env ?? process.env;
  async function installedVersion(provider, executable, env, checkedAt) {
    let command;
    try {
      command = await runCommand(executable, ["--version"], {
        env,
        timeoutMs: CHECK_TIMEOUT_MS
      });
    } catch (error) {
      if (isMissingExecutable(error)) {
        return {
          provider,
          state: "not_installed",
          installedVersion: null,
          latestVersion: null,
          channel: null,
          checkedAt,
          reason: "cli_not_found"
        };
      }
      return unknownStatus(provider, checkedAt, "check_failed");
    }
    return parseVersion(`${command.stdout}
${command.stderr}`) ?? unknownStatus(provider, checkedAt, "version_unavailable");
  }
  async function checkClaude(checkedAt) {
    const executable = config.claudePath ?? "claude";
    const env = childEnv("claude", baseEnv);
    const [installed, doctorResult] = await Promise.all([
      installedVersion("claude", executable, env, checkedAt),
      runCommand(executable, ["doctor"], { env, timeoutMs: CHECK_TIMEOUT_MS }).then((value) => ({ ok: true, value })).catch(() => ({ ok: false }))
    ]);
    if ("state" in installed) return installed;
    if (!doctorResult.ok) {
      return unknownStatus("claude", checkedAt, "check_failed", installed.version);
    }
    const doctor = doctorResult.value;
    const metadata = parseClaudeDoctor(`${doctor.stdout}
${doctor.stderr}`);
    if (!metadata) {
      return unknownStatus("claude", checkedAt, "check_failed", installed.version);
    }
    if (metadata.installMethod !== "native") {
      return unknownStatus(
        "claude",
        checkedAt,
        "unsupported_installation",
        installed.version
      );
    }
    if (!metadata.channel) {
      return unknownStatus("claude", checkedAt, "version_unavailable", installed.version);
    }
    let latest;
    try {
      const response = await fetchText(
        `${CLAUDE_RELEASE_BASE_URL}/${metadata.channel}`,
        { timeoutMs: CHECK_TIMEOUT_MS }
      );
      latest = parseVersion(response);
    } catch {
      latest = null;
    }
    if (!latest) {
      return {
        ...unknownStatus("claude", checkedAt, "version_unavailable", installed.version),
        channel: metadata.channel
      };
    }
    return statusFromVersions({
      provider: "claude",
      installed,
      latest,
      channel: metadata.channel,
      checkedAt
    });
  }
  async function checkCodex(checkedAt) {
    const executable = config.codexPath ?? "codex";
    const env = childEnv("codex", baseEnv);
    const [installed, doctorResult] = await Promise.all([
      installedVersion("codex", executable, env, checkedAt),
      runCommand(executable, ["doctor", "--json"], { env, timeoutMs: CODEX_DOCTOR_TIMEOUT_MS }).then((value) => ({ ok: true, value })).catch(() => ({ ok: false }))
    ]);
    if ("state" in installed) return installed;
    if (!doctorResult.ok) {
      return unknownStatus("codex", checkedAt, "check_failed", installed.version);
    }
    const doctor = doctorResult.value;
    const latest = parseCodexLatestVersion(doctor.stdout);
    if (!latest) {
      return unknownStatus("codex", checkedAt, "version_unavailable", installed.version);
    }
    return statusFromVersions({
      provider: "codex",
      installed,
      latest,
      channel: null,
      checkedAt
    });
  }
  const check = async (provider) => {
    const checkedAt = now().toISOString();
    return provider === "claude" ? checkClaude(checkedAt) : checkCodex(checkedAt);
  };
  function executableFor(provider) {
    return provider === "claude" ? config.claudePath ?? "claude" : config.codexPath ?? "codex";
  }
  function refusal(provider, reason, error, output = "") {
    return { provider, ok: false, exitCode: null, output, error, reason };
  }
  function failureFromError(provider, executable, step, error) {
    const output = partialOutput(error);
    if (isMissingExecutable(error)) {
      return refusal(provider, "cli_not_found", `${executable} was not found.`, output);
    }
    if (isTimeoutError(error)) {
      return refusal(
        provider,
        "timed_out",
        `${executable} ${step.args} timed out after ${formatTimeout(step.timeoutMs)}.`,
        output
      );
    }
    return {
      provider,
      ok: false,
      exitCode: null,
      output,
      error: error instanceof Error ? error.message : String(error),
      reason: null
    };
  }
  async function claudeInstallMethod(executable, env) {
    const doctor = await runCommand(executable, ["doctor"], {
      env,
      timeoutMs: CHECK_TIMEOUT_MS
    });
    const output = doctor.stderr ? `${doctor.stdout}
${doctor.stderr}` : doctor.stdout;
    return {
      installMethod: parseClaudeDoctor(output)?.installMethod ?? null,
      // Kept even on refusal: when the parse fails, the transcript that
      // failed to parse is the one artifact that explains why.
      output
    };
  }
  const apply = async (provider) => {
    const executable = executableFor(provider);
    const env = childEnv(provider, baseEnv);
    if (provider === "claude") {
      let installMethod;
      let doctorOutput;
      try {
        ({ installMethod, output: doctorOutput } = await claudeInstallMethod(executable, env));
      } catch (error) {
        return failureFromError(
          provider,
          executable,
          { args: "doctor", timeoutMs: CHECK_TIMEOUT_MS },
          error
        );
      }
      if (installMethod === null) {
        return refusal(
          provider,
          "install_method_unknown",
          "Could not read how Claude Code was installed, so the updater was not run.",
          doctorOutput
        );
      }
      if (installMethod !== "native") {
        return refusal(
          provider,
          "unsupported_installation",
          `Claude Code was installed with ${installMethod}; update it with that package manager.`,
          doctorOutput
        );
      }
    }
    let command;
    try {
      command = await runCommand(executable, ["update"], {
        env,
        timeoutMs: APPLY_TIMEOUT_MS
      });
    } catch (error) {
      return failureFromError(
        provider,
        executable,
        { args: "update", timeoutMs: APPLY_TIMEOUT_MS },
        error
      );
    }
    return {
      provider,
      ok: command.exitCode === 0,
      exitCode: command.exitCode,
      output: command.stderr ? `${command.stdout}
${command.stderr}` : command.stdout,
      error: null,
      reason: null
    };
  };
  return {
    check,
    checkAll: () => Promise.all([
      check("claude"),
      check("codex")
    ]),
    apply
  };
}
export {
  AbortError,
  CLAUDE_ABSORBED_FOLLOW_UP_GRACE_MS,
  CLAUDE_CONTEXT_WINDOWS,
  CLAUDE_FOLLOW_UP_GRACE_MS,
  CLAUDE_INTERRUPT_GRACE_MS,
  CLAUDE_STRIPPED_ENV_VARS,
  CODEX_FORK_CONFIG,
  CODEX_STRIPPED_ENV_VARS,
  CodexTurnError,
  KNOWN_CONTEXT_WINDOWS,
  MissingCliError,
  SteerRejectedError,
  TimeoutError,
  UnsupportedServerRequestError,
  collectCodexModels,
  contextWindowForModel,
  createClaudeSession,
  createClaudeSessionState,
  createClaudeTurnTranslator,
  createCodexAppServerClient,
  createCodexAppServerSession,
  createModelCatalogService,
  createProviderUpdateService,
  deleteClaudeSession,
  forkClaudeSession,
  forkCodexThread,
  parseClaudeCliHelp,
  runClaude,
  runCodex
};
//# sourceMappingURL=index.js.map