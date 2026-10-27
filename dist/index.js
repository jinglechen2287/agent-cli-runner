// src/claude-session.ts
import { spawn as nodeSpawn2 } from "child_process";
import { randomUUID } from "crypto";
import {
  query as sdkQuery
} from "@anthropic-ai/claude-agent-sdk";

// src/internal.ts
import { spawn as nodeSpawn } from "child_process";
import { accessSync, constants, statSync } from "fs";
import { delimiter, join, resolve as resolvePath } from "path";
import { StringDecoder } from "string_decoder";

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
var SteerRejectedError = class extends Error {
  name = "SteerRejectedError";
};

// src/internal.ts
var SIGTERM_GRACE_MS = 2e3;
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
function filterEnv(base, stripped) {
  const env = {};
  const normalize = (key) => process.platform === "win32" ? key.toUpperCase() : key;
  const strippedKeys = new Set(stripped.map(normalize));
  for (const [key, value] of Object.entries(base)) {
    if (value !== void 0 && !strippedKeys.has(normalize(key))) env[key] = value;
  }
  return env;
}
function isMissingExecutable(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function createLineSplitter(onLine) {
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        onLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },
    flush() {
      buffer += decoder.end();
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
function watchLifecycle(opts) {
  let aborted = false;
  let timedOut = false;
  let killTimer;
  let timeoutTimer;
  const terminate = () => {
    opts.kill("SIGTERM");
    killTimer ??= setTimeout(() => opts.kill("SIGKILL"), SIGTERM_GRACE_MS);
  };
  const abortHandler = () => {
    if (aborted || timedOut) return;
    aborted = true;
    terminate();
  };
  if (opts.signal) {
    if (opts.signal.aborted) abortHandler();
    else opts.signal.addEventListener("abort", abortHandler, { once: true });
  }
  if (opts.timeoutMs !== void 0) {
    timeoutTimer = setTimeout(() => {
      if (aborted || timedOut) return;
      timedOut = true;
      terminate();
    }, opts.timeoutMs);
  }
  return {
    interruptionError() {
      if (aborted) return new AbortError(`${opts.cli} run aborted`);
      if (timedOut) {
        return new TimeoutError(`${opts.cli} run timed out after ${opts.timeoutMs}ms`);
      }
      return null;
    },
    cleanup() {
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      opts.signal?.removeEventListener("abort", abortHandler);
    }
  };
}
function signalProcessTree(child, signal) {
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
      try {
        child.kill(signal);
      } catch {
      }
    };
    killer.once("error", fallback);
    killer.once("exit", (code) => {
      if (code !== 0) fallback();
    });
    return;
  }
  try {
    child.kill(signal);
  } catch {
  }
}
function resolveExecutable(name, env) {
  if (process.platform === "win32") return name;
  const isExecutable = (candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  if (name.includes("/")) return isExecutable(name) ? resolvePath(name) : void 0;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return void 0;
}

// src/usage.ts
var KNOWN_CONTEXT_WINDOWS = {
  "gpt-5.2": 272e3,
  "gpt-5.4": 272e3,
  "gpt-5.4-mini": 272e3,
  "gpt-5.5": 272e3,
  "gpt-5.6-luna": 372e3,
  "gpt-5.6-sol": 372e3,
  "gpt-5.6-terra": 372e3,
  "codex-auto-review": 272e3
};
var CLAUDE_DEFAULT_CONTEXT_WINDOW = 2e5;
var CLAUDE_1M_CONTEXT_WINDOW = 1e6;
function contextWindowForModel(model) {
  if (!model) return void 0;
  const id = model.trim().toLowerCase();
  if (!id) return void 0;
  if (Object.prototype.hasOwnProperty.call(KNOWN_CONTEXT_WINDOWS, id)) {
    return KNOWN_CONTEXT_WINDOWS[id];
  }
  if (id.includes("claude")) {
    if (/fable|mythos/.test(id)) return CLAUDE_1M_CONTEXT_WINDOW;
    return /\[1m\]|[-_]1m\b/.test(id) ? CLAUDE_1M_CONTEXT_WINDOW : CLAUDE_DEFAULT_CONTEXT_WINDOW;
  }
  if (id.startsWith("gpt-5.6")) return 372e3;
  if (id.startsWith("gpt-5")) return 272e3;
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
  if (name !== "TodoWrite" || !input || !Array.isArray(input.todos)) return void 0;
  const items = [];
  for (const raw of input.todos) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
    const record2 = raw;
    const text2 = normalizeSummary(record2.content) ?? normalizeSummary(record2.activeForm);
    const status = normalizeSummary(record2.status)?.toLowerCase().replace(/\s+/g, "_");
    if (!text2 || !status) return void 0;
    items.push({ text: text2, status });
  }
  return items.length > 0 ? items : void 0;
}
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
function toClaudeUsage(usage, model, contextWindow) {
  const input = toTokenCount(usage.input_tokens);
  const cacheRead = toTokenCount(usage.cache_read_input_tokens);
  const cacheCreation = toTokenCount(usage.cache_creation_input_tokens);
  return {
    contextTokens: input + cacheRead + cacheCreation,
    inputTokens: input,
    cachedInputTokens: cacheRead,
    outputTokens: toTokenCount(usage.output_tokens),
    ...model ? { model } : {},
    ...contextWindow !== void 0 ? { contextWindow } : {}
  };
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
  let sessionModel;
  let lastMessageUsage;
  let lastUsage;
  const agentToolCallIds = /* @__PURE__ */ new Set();
  const backgroundAgents = /* @__PURE__ */ new Map();
  const liveTaskIds = /* @__PURE__ */ new Set();
  const liveAgentTaskIds = /* @__PURE__ */ new Set();
  const settleTask = (taskId) => {
    liveTaskIds.delete(taskId);
    if (liveAgentTaskIds.delete(taskId) && resultSeen) followUpPending = true;
  };
  const isForeignResult = (parsed) => {
    if (promptUuid === void 0) return false;
    const named = namedPromptUuids(parsed);
    if (named) return !named.some((uuid) => expected.includes(uuid));
    if (resultSeen) return false;
    if (options.cliEchoesPromptUuid || echoedPromptUuid) return true;
    const failed = parsed.is_error === true || typeof parsed.subtype === "string" && parsed.subtype !== "success";
    return !failed && !outputSeen && !parsed.result;
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
  const handle = (message) => {
    if (!isRecord(message)) return;
    const parsed = message;
    if (parsed.type === "stream_event") {
      if (parsed.parent_tool_use_id) return;
      const delta = parsed.event?.type === "content_block_delta" ? parsed.event.delta : void 0;
      if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        const text2 = delta.text;
        safeCallback(() => callbacks.onAssistantTextDelta?.(text2));
      }
      return;
    }
    if (parsed.type === "system" && parsed.subtype === "init") {
      if (typeof parsed.model === "string" && parsed.model) sessionModel = parsed.model;
      if (parsed.session_id) emitSessionId(parsed.session_id);
      return;
    }
    if (parsed.type === "system" && parsed.subtype === "task_started" && typeof parsed.task_id === "string") {
      liveTaskIds.add(parsed.task_id);
      const isAgent = parsed.task_type === "local_agent" || parsed.task_type === "remote_agent" || typeof parsed.tool_use_id === "string" && agentToolCallIds.has(parsed.tool_use_id);
      if (!isAgent) return;
      liveAgentTaskIds.add(parsed.task_id);
      const now = Date.now();
      emitBackgroundAgent({
        id: parsed.task_id,
        provider: "claude",
        ...typeof parsed.tool_use_id === "string" ? { parentToolCallId: parsed.tool_use_id } : {},
        ...typeof parsed.description === "string" ? { description: parsed.description } : {},
        ...typeof parsed.task_type === "string" ? { agentType: parsed.task_type } : {},
        status: "running",
        startedAt: now,
        updatedAt: now
      });
      return;
    }
    if (parsed.type === "system" && parsed.subtype === "task_progress" && typeof parsed.task_id === "string") {
      const current = backgroundAgents.get(parsed.task_id);
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
        ...typeof parsed.tool_use_id === "string" ? { parentToolCallId: parsed.tool_use_id } : {},
        ...typeof parsed.description === "string" ? { description: parsed.description } : {},
        ...typeof parsed.subagent_type === "string" ? { agentType: parsed.subagent_type } : {},
        ...typeof parsed.summary === "string" ? { summary: parsed.summary } : {},
        ...Object.keys(progress).length > 0 ? { progress } : {},
        // A trailing progress rollup can arrive after the terminal
        // task_updated; it must not resurrect a finished agent.
        status: current.status === "completed" || current.status === "failed" || current.status === "interrupted" ? current.status : "running",
        updatedAt: Date.now()
      });
      return;
    }
    if (parsed.type === "system" && parsed.subtype === "task_updated" && typeof parsed.task_id === "string") {
      if (isTerminalTaskStatus(parsed.patch?.status)) settleTask(parsed.task_id);
      const current = backgroundAgents.get(parsed.task_id);
      if (!current || !parsed.patch) return;
      const status = claudeBackgroundAgentStatus(parsed.patch.status) ?? current.status;
      const now = Date.now();
      emitBackgroundAgent({
        ...current,
        ...typeof parsed.patch.description === "string" ? { description: parsed.patch.description } : {},
        ...typeof parsed.patch.error === "string" ? { error: parsed.patch.error } : {},
        status,
        updatedAt: now,
        ...status === "completed" || status === "failed" || status === "interrupted" ? {
          endedAt: current.endedAt ?? (typeof parsed.patch.end_time === "number" ? parsed.patch.end_time : now)
        } : {}
      });
      return;
    }
    if (parsed.type === "system" && parsed.subtype === "task_notification" && typeof parsed.task_id === "string") {
      if (isTerminalTaskStatus(parsed.status)) settleTask(parsed.task_id);
      return;
    }
    if (parsed.type === "assistant" && parsed.message?.content) {
      const texts = [];
      for (const block of parsed.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          if ((block.name === "Agent" || block.name === "Task") && typeof block.id === "string") {
            agentToolCallIds.add(block.id);
          }
          const planItems2 = claudeTodoPlanItems(block.name, block.input);
          const summary = planItems2 ? planCompletionSummary(planItems2) : summarizeClaudeTool(block.name, block.input);
          const info = {
            ...typeof block.id === "string" ? { callId: block.id } : {},
            name: block.name,
            ...summary !== void 0 ? { summary } : {},
            ...block.input ? { input: block.input } : {},
            ...planItems2 ? { planItems: planItems2 } : {}
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
      const model = qualifyModel(parsed.message.model, sessionModel);
      if (model) lastAssistantModel = model;
      if (parsed.message.usage) {
        lastMessageUsage = parsed.message.usage;
        emitUsage(
          toClaudeUsage(parsed.message.usage, model, contextWindowForModel(model))
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
          ...typeof block.is_error === "boolean" ? { isError: block.is_error } : {}
        };
        safeCallback(() => callbacks.onToolResult?.(result));
      }
      return;
    }
    if (parsed.type === "result") {
      if (namedPromptUuids(parsed)) echoedPromptUuid = true;
      if (isForeignResult(parsed)) return;
      const followUp = resultSeen;
      resultSeen = true;
      followUpPending = false;
      const named = namedPromptUuids(parsed);
      if (named) {
        const last = Math.max(...named.map((uuid) => expected.indexOf(uuid)));
        answeredCount = Math.max(answeredCount, last + 1);
      } else if (options.cliEchoesPromptUuid || echoedPromptUuid) {
        answeredCount = Math.max(answeredCount, 1);
      } else {
        answeredCount = expected.length;
      }
      if (parsed.session_id) emitSessionId(parsed.session_id);
      if (typeof parsed.result === "string" && (!followUp || parsed.result)) {
        resultText = parsed.result;
      }
      isError = parsed.is_error === true || typeof parsed.subtype === "string" && parsed.subtype !== "success";
      errors = Array.isArray(parsed.errors) ? parsed.errors.filter((entry) => typeof entry === "string") : [];
      const occupancy = lastMessageUsage ?? (parsed.usage && countsTokens(parsed.usage) ? parsed.usage : void 0);
      if (occupancy) {
        const primary = pickPrimaryModel(parsed.modelUsage, lastAssistantModel ?? sessionModel);
        const model = primary?.model ?? lastAssistantModel;
        const contextWindow = primary?.contextWindow ?? contextWindowForModel(model);
        emitUsage(toClaudeUsage(occupancy, model, contextWindow));
      }
    }
  };
  const allAnswered = () => answeredCount >= expected.length;
  return {
    handle,
    expectUserMessage(uuid) {
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

// src/claude-session.ts
var CLAUDE_STRIPPED_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN"
];
var CLAUDE_INTERRUPT_GRACE_MS = 5e3;
var CLAUDE_FOLLOW_UP_GRACE_MS = 6e4;
var TURN_MESSAGE_TYPES = /* @__PURE__ */ new Set(["assistant", "user", "stream_event", "result"]);
var STDERR_TAIL_CHARS = 2e3;
function validateSessionOptions(opts) {
  if (opts.newSessionId && opts.resumeSessionId) {
    throw new Error(
      "newSessionId and resumeSessionId are mutually exclusive \u2014 pass one or the other"
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
}
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
    env: filterEnv(opts.env ?? process.env, CLAUDE_STRIPPED_ENV_VARS),
    pathToClaudeCodeExecutable: executablePath,
    spawnClaudeCodeProcess,
    ...opts.resumeSessionId ? { resume: opts.resumeSessionId } : { sessionId },
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
    ...opts.hooks ? { hooks: opts.hooks } : {},
    ...opts.isolated ? { strictMcpConfig: true, persistSession: false, extraArgs: { "safe-mode": null } } : {}
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
  const executablePath = resolveExecutable(opts.executablePath ?? "claude", env);
  if (!executablePath) throw new MissingCliError("claude");
  const sessionId = opts.resumeSessionId ?? opts.newSessionId ?? randomUUID();
  const spawnFn = opts.spawnFn ?? nodeSpawn2;
  const queryFn = opts.queryFn ?? sdkQuery;
  const interruptGraceMs = opts.interruptGraceMs ?? CLAUDE_INTERRUPT_GRACE_MS;
  const followUpGraceMs = opts.followUpGraceMs ?? CLAUDE_FOLLOW_UP_GRACE_MS;
  let cliEchoesPromptUuid = false;
  let closed = false;
  let child;
  let childExited = false;
  let active;
  let stderrTail = "";
  const closeHandlers = /* @__PURE__ */ new Set();
  const exitWaiters = /* @__PURE__ */ new Set();
  const input = createInputQueue();
  const spawnClaudeCodeProcess = (spawnOptions) => {
    const spawned = spawnFn(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd ?? opts.cwd,
      env: spawnOptions.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Process-group leader (POSIX), so killing the session reaches tool
      // children (a running Bash) as well as the CLI.
      detached: process.platform !== "win32"
    });
    child = spawned;
    spawned.once("exit", () => {
      childExited = true;
      for (const waiter of exitWaiters) waiter();
      exitWaiters.clear();
    });
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
    if (!spawned.stdin || !spawned.stdout) {
      throw new Error("Claude process was spawned without stdio pipes");
    }
    const stdin = spawned.stdin;
    const stdout = spawned.stdout;
    return {
      stdin,
      stdout,
      get killed() {
        return spawned.killed;
      },
      get exitCode() {
        return spawned.exitCode;
      },
      get signalCode() {
        return spawned.signalCode;
      },
      kill(signal) {
        signalProcessTree(spawned, signal);
        return true;
      },
      on: spawned.on.bind(spawned),
      once: spawned.once.bind(spawned),
      off: spawned.off.bind(spawned)
    };
  };
  const options = claudeSessionQueryOptions(opts, sessionId, executablePath, spawnClaudeCodeProcess);
  const runtime = queryFn({ prompt: input.iterable, options });
  const killTree = () => {
    const current = child;
    if (!current || childExited) return Promise.resolve();
    return new Promise((resolve) => {
      let killTimer;
      let giveUpTimer;
      const done = () => {
        if (killTimer) clearTimeout(killTimer);
        if (giveUpTimer) clearTimeout(giveUpTimer);
        exitWaiters.delete(done);
        resolve();
      };
      exitWaiters.add(done);
      signalProcessTree(current, "SIGTERM");
      killTimer = setTimeout(() => {
        signalProcessTree(current, "SIGKILL");
        giveUpTimer = setTimeout(done, SIGTERM_GRACE_MS);
        giveUpTimer.unref?.();
      }, SIGTERM_GRACE_MS);
      killTimer.unref?.();
    });
  };
  const interruptionError = (turn) => turn.interruption === "timeout" ? new TimeoutError(`claude run timed out after ${turn.timeoutMs}ms`) : new AbortError("claude run aborted");
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
  const exitError = (cause) => {
    const detail = cause instanceof Error ? cause.message : "Claude process exited";
    const tail = stderrTail.trim();
    return new Error(tail && !detail.includes(tail) ? `${detail}: ${tail}` : detail);
  };
  const settleTurn = (turn) => {
    if (active !== turn) return;
    active = void 0;
    const outcome = turn.translator.finish();
    if (turn.interruption) {
      turn.reject(interruptionError(turn));
    } else {
      turn.resolve({
        text: outcome.text,
        exitCode: outcome.isError ? 1 : 0,
        ...outcome.sessionId !== void 0 ? { sessionId: outcome.sessionId } : {},
        ...outcome.usage !== void 0 ? { usage: outcome.usage } : {}
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
        turn.translator.handle(message);
        if (turn.translator.echoedPromptUuid) cliEchoesPromptUuid = true;
        if (turn.translator.done) {
          settleTurn(turn);
        } else if (turn.translator.awaitingFollowUp) {
          if (turn.followUpTimer) clearTimeout(turn.followUpTimer);
          turn.followUpTimer = setTimeout(() => settleTurn(turn), followUpGraceMs);
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
  return {
    sessionId,
    cwd: opts.cwd,
    get closed() {
      return closed;
    },
    runTurn(turnOptions) {
      if (closed) return Promise.reject(closeReason ?? new Error("Claude session is closed"));
      if (active) return Promise.reject(new Error("Claude session already has an active turn"));
      const { prompt, signal, timeoutMs, ...callbacks } = turnOptions;
      if (signal?.aborted) return Promise.reject(new AbortError("claude run aborted"));
      return new Promise((resolve, reject) => {
        let timeoutTimer;
        let graceTimer;
        const cleanup = () => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (graceTimer) clearTimeout(graceTimer);
          if (turn.followUpTimer) clearTimeout(turn.followUpTimer);
          signal?.removeEventListener("abort", onAbort);
        };
        const promptUuid = randomUUID();
        const turn = {
          translator: createClaudeTurnTranslator(callbacks, { promptUuid, cliEchoesPromptUuid }),
          callbacks,
          interruption: null,
          timeoutMs,
          followUpTimer: void 0,
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
        input.push({
          type: "user",
          message: { role: "user", content: prompt },
          parent_tool_use_id: null,
          uuid: promptUuid
        });
      });
    },
    steer({ prompt }) {
      if (closed) return Promise.reject(new SteerRejectedError("Claude session is closed"));
      const turn = active;
      if (!turn) return Promise.reject(new SteerRejectedError("Claude session has no active turn"));
      if (turn.interruption) {
        return Promise.reject(new SteerRejectedError("Claude turn is being interrupted"));
      }
      if (turn.translator.resultSeen) {
        return Promise.reject(new SteerRejectedError("Claude turn is already finishing"));
      }
      const uuid = randomUUID();
      turn.translator.expectUserMessage(uuid);
      input.push({
        type: "user",
        message: { role: "user", content: prompt },
        parent_tool_use_id: null,
        uuid,
        // Read between tool rounds of the running turn, not held until it ends.
        priority: "next"
      });
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
    ...callbacks
  } = opts;
  if (signal?.aborted) throw new AbortError("claude run aborted");
  const session = await createClaudeSession({
    cwd,
    ...executablePath !== void 0 ? { executablePath } : {},
    ...env !== void 0 ? { env } : {},
    ...spawnFn !== void 0 ? { spawnFn } : {},
    ...queryFn !== void 0 ? { queryFn } : {},
    ...model !== void 0 ? { model } : {},
    ...effort !== void 0 ? { effort } : {},
    ...appendSystemPrompt !== void 0 ? { appendSystemPrompt } : {},
    ...permissionMode !== void 0 ? { permissionMode } : {},
    ...disallowedTools !== void 0 ? { disallowedTools } : {},
    ...tools !== void 0 ? { tools } : {},
    ...allowedTools !== void 0 ? { allowedTools } : {},
    ...settingSources !== void 0 ? { settingSources } : {},
    ...settings !== void 0 ? { settings } : {},
    ...hooks !== void 0 ? { hooks } : {},
    ...newSessionId !== void 0 ? { newSessionId } : {},
    ...resumeSessionId !== void 0 ? { resumeSessionId } : {},
    ...isolated !== void 0 ? { isolated } : {}
  });
  try {
    return await session.runTurn({
      prompt,
      ...signal !== void 0 ? { signal } : {},
      ...timeoutMs !== void 0 ? { timeoutMs } : {},
      ...callbacks
    });
  } finally {
    await session.close();
  }
}

// src/run-codex.ts
import { spawn } from "child_process";

// src/codex-app-server.ts
import { spawn as nodeSpawn3 } from "child_process";
var DEFAULT_REQUEST_TIMEOUT_MS = 1e4;
var TURN_START_TIMEOUT_MS = 6e4;
var MAX_PRE_ACK_NOTIFICATIONS = 1e4;
var CLIENT_INFO = {
  name: "agent_cli_runner",
  title: "Agent CLI Runner",
  version: "0.1.0"
};
var clientExitPromises = /* @__PURE__ */ new WeakMap();
function rpcError(value, fallback) {
  if (!isRecord(value)) return new Error(fallback);
  const message = typeof value.message === "string" ? value.message : fallback;
  const error = new Error(message);
  if (value.code !== void 0) error.code = value.code;
  if (value.data !== void 0) error.data = value.data;
  return error;
}
async function createCodexAppServerClient(options) {
  const spawnFn = options.spawnFn ?? nodeSpawn3;
  let child;
  try {
    child = spawnFn(options.executablePath ?? "codex", ["app-server", "--stdio"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: filterEnv(options.env ?? process.env, ["CODEX_THREAD_ID"]),
      detached: process.platform !== "win32"
    });
  } catch (error) {
    if (error instanceof Error && isMissingExecutable(error)) throw new MissingCliError("codex");
    throw error;
  }
  const pending = /* @__PURE__ */ new Map();
  const notificationHandlers = /* @__PURE__ */ new Set();
  let serverRequestRegistration;
  const stderrHandlers = /* @__PURE__ */ new Set();
  const closeHandlers = /* @__PURE__ */ new Set();
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let nextId = 1;
  let closed = false;
  let closeError;
  let childExited = false;
  let terminationRequested = false;
  let killTimer;
  let exitFallbackTimer;
  let stderr = "";
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
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
    childExited = true;
    resolveExit();
    if (killTimer) clearTimeout(killTimer);
    if (exitFallbackTimer) clearTimeout(exitFallbackTimer);
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
      if (terminationRequested || childExited) return;
      terminationRequested = true;
      if (!closed) fail(new Error("Codex app-server was closed"));
      signalProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        if (childExited) return;
        signalProcessTree(child, "SIGKILL");
        exitFallbackTimer = setTimeout(resolveExit, SIGTERM_GRACE_MS);
        exitFallbackTimer.unref();
      }, SIGTERM_GRACE_MS);
      killTimer.unref();
    }
  };
  clientExitPromises.set(client, exitPromise);
  try {
    await client.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true }
    });
    client.notify("initialized", {});
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
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
    case "mcp_tool_call":
      return text(item.tool) ?? "MCP";
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
  if (!Array.isArray(value)) return void 0;
  const items = [];
  for (const raw of value) {
    const step = record(raw);
    const itemText = normalizeSummary(step?.step ?? step?.text);
    const status = normalizePlanStatus(step?.status);
    if (!itemText || !status) return void 0;
    items.push({ text: itemText, status });
  }
  return items.length > 0 ? items : void 0;
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
function terminalBackgroundStatus(status) {
  return status === "completed" || status === "failed" || status === "interrupted";
}
function toUsage(params, threadId, turnId, model, fallbackWindow) {
  if (params.threadId !== threadId || params.turnId !== turnId) return void 0;
  const tokenUsage = record(params.tokenUsage);
  const last = record(tokenUsage?.last);
  if (!last) return void 0;
  if (toTokenCount(last.totalTokens) <= 0) return void 0;
  const input = toTokenCount(last.inputTokens);
  const cached = toTokenCount(last.cachedInputTokens);
  const contextWindow = toContextWindow(tokenUsage?.modelContextWindow) ?? fallbackWindow;
  return {
    // Input side only (cached included), per the TokenUsage contract — not
    // last.totalTokens, which also counts output. Matches the Claude and
    // isolated-exec paths.
    contextTokens: input,
    inputTokens: Math.max(0, input - cached),
    cachedInputTokens: cached,
    outputTokens: toTokenCount(last.outputTokens),
    ...model ? { model } : {},
    ...contextWindow !== void 0 ? { contextWindow } : {}
  };
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
function requestCodexThread(client, opts) {
  const params = {
    cwd: opts.cwd,
    experimentalRawEvents: true,
    ...opts.model ? { model: opts.model } : {},
    ...opts.developerInstructions ? { developerInstructions: opts.developerInstructions } : {},
    ...opts.dangerouslyBypassApprovalsAndSandbox ? { approvalPolicy: "never", sandbox: "danger-full-access" } : {}
  };
  return opts.resumeSessionId ? client.request("thread/resume", { threadId: opts.resumeSessionId, ...params }) : client.request("thread/start", params);
}
function openedCodexThread(value, fallbackModel) {
  const threadId = threadIdFrom(value);
  if (!threadId) throw new CodexTurnError("Codex app-server did not return a thread ID");
  const model = text(record(value)?.model) ?? fallbackModel;
  return { threadId, ...model ? { model } : {} };
}
async function runCodexAppServerTurn(opts, client, openedThread, ownedClient = false, continuity, retireClientOnUnackedStart = ownedClient) {
  if (opts.signal?.aborted) throw new AbortError("codex run aborted");
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
    flushPendingWebTools();
    settleError(held.error);
  };
  const matchTurn = (eventTurnId) => {
    if (!turnStartSent || !eventTurnId) return void 0;
    if (isPreviousTurn(eventTurnId)) return void 0;
    if (turnId && eventTurnId !== turnId) return void 0;
    if (!turnId) {
      turnId = eventTurnId;
      resolvePendingTurnError();
    }
    return eventTurnId;
  };
  let resolvedModel = opts.model ?? openedThread?.model;
  let finalText = "";
  let latestUsage;
  let settled = false;
  let interruption;
  let timeout;
  const emittedTools = /* @__PURE__ */ new Set();
  const backgroundAgents = /* @__PURE__ */ new Map();
  const pendingWebTools = /* @__PURE__ */ new Map();
  const rawWebCalls = /* @__PURE__ */ new Map();
  const unassignedRawWebCalls = [];
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => {
  });
  let rejectLifecycle;
  let lifecycleFailed = false;
  const lifecycleFailure = new Promise((_resolve, reject) => {
    rejectLifecycle = reject;
  });
  const failLifecycle = (error) => {
    if (lifecycleFailed) return;
    lifecycleFailed = true;
    rejectLifecycle(error);
  };
  const raceLifecycle = (operation) => Promise.race([operation, lifecycleFailure]);
  let resolveTurnKnown;
  const turnKnown = new Promise((resolve) => {
    resolveTurnKnown = resolve;
  });
  const steer = async (prompt) => {
    if (settled || interruption) throw new SteerRejectedError("Codex turn is already finishing");
    try {
      const known = await Promise.race([
        turnKnown,
        completion.then(() => {
          throw new SteerRejectedError("Codex turn ended before it could be steered");
        }),
        lifecycleFailure
      ]);
      if (!known) throw new SteerRejectedError("Codex turn ended before it could be steered");
    } catch (error) {
      if (error instanceof SteerRejectedError) throw error;
      throw new SteerRejectedError(
        `Codex turn ended before it could be steered: ${error instanceof Error ? error.message : String(error)}`
      );
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
      throw new SteerRejectedError(
        `Codex refused the steer: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
  continuity?.onSteerable?.(steer);
  const settleError = (error) => {
    if (settled) return;
    settled = true;
    rejectCompletion(error);
  };
  const requestInterrupt = () => {
    if (!interruption || !threadId || !turnId) return;
    void client.request("turn/interrupt", { threadId, turnId }).catch(() => {
    }).finally(() => failLifecycle(interruption));
  };
  const interrupt = (error) => {
    if (interruption || settled) return;
    interruption = error;
    if (threadId && turnId) requestInterrupt();
    else failLifecycle(error);
  };
  const abortHandler = () => interrupt(new AbortError("codex run aborted"));
  if (opts.signal) {
    if (opts.signal.aborted) abortHandler();
    else opts.signal.addEventListener("abort", abortHandler, { once: true });
  }
  let runDeadline;
  if (opts.timeoutMs !== void 0) {
    runDeadline = Date.now() + opts.timeoutMs;
    timeout = setTimeout(
      () => interrupt(new TimeoutError(`codex run timed out after ${opts.timeoutMs}ms`)),
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
    emitToolUse(id, item);
    if (pending.completed) emitToolResult(id, item);
    if (pending.completed || force) pendingWebTools.delete(id);
  };
  const flushPendingWebTools = () => {
    for (const id of [...pendingWebTools.keys()]) emitPendingWebTool(id, true);
  };
  const handleRawResponseItem = (params) => {
    const item = record(params.item);
    if (!item) return;
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
  };
  const updateBackgroundAgents = (item, occurredAt) => {
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
        ...terminalBackgroundStatus(status) ? { endedAt: current?.endedAt ?? occurredAt } : {}
      };
      if (status === "failed") delete agent.summary;
      else delete agent.error;
      backgroundAgents.set(id, agent);
      safeCallback(() => opts.onBackgroundAgentUpdate?.(agent));
    }
  };
  const handleItem = (method, params) => {
    if (params.threadId !== threadId) return;
    if (!matchTurn(text(params.turnId))) return;
    const item = record(params.item);
    if (!item) return;
    const occurredAt = typeof params.startedAtMs === "number" ? params.startedAtMs : typeof params.completedAtMs === "number" ? params.completedAtMs : Date.now();
    updateBackgroundAgents(item, occurredAt);
    if (method === "item/completed" && itemType(item) === "agentMessage") {
      const message = text(item.text);
      if (message) {
        finalText = message;
        safeCallback(() => opts.onAssistantText?.(message));
      }
      return;
    }
    if (isWebItem(item)) {
      const id2 = text(item.id) ?? `${itemType(item)}:web`;
      const pending = pendingWebTools.get(id2) ?? {
        item,
        completed: false
      };
      pending.item = item;
      pending.completed = method === "item/completed";
      assignRawWebCall(id2, pending);
      pendingWebTools.set(id2, pending);
      if (pending.completed) emitPendingWebTool(id2, false);
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
      handleItem(method, params);
      return;
    }
    if (method === "item/agentMessage/delta") {
      if (params.threadId !== threadId) return;
      if (!matchTurn(text(params.turnId))) return;
      const chunk = typeof params.delta === "string" ? params.delta : "";
      if (chunk) safeCallback(() => opts.onAssistantTextDelta?.(chunk));
      return;
    }
    if (method === "rawResponseItem/completed") {
      if (params.threadId !== threadId) return;
      if (!matchTurn(text(params.turnId))) return;
      handleRawResponseItem(params);
      return;
    }
    if (method === "turn/plan/updated" && params.threadId === threadId) {
      const eventTurnId = matchTurn(text(params.turnId));
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
      flushPendingWebTools();
      settleError(new CodexTurnError(`Codex error: ${message2}`));
      return;
    }
    if (method !== "turn/completed" || params.threadId !== threadId) return;
    if (!matchTurn(text(record(params.turn)?.id))) return;
    flushPendingWebTools();
    if (interruption) {
      failLifecycle(interruption);
      return;
    }
    const status = text(record(params.turn)?.status);
    if (status === "completed") {
      if (!settled) {
        settled = true;
        resolveCompletion();
      }
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
    if (!openedThread) {
      const opened = openedCodexThread(
        await raceLifecycle(requestCodexThread(client, opts)),
        resolvedModel
      );
      threadId = opened.threadId;
      resolvedModel = opened.model;
    }
    safeCallback(() => opts.onSessionId?.(threadId));
    const input = [
      { type: "text", text: opts.prompt, text_elements: [] },
      ...(opts.imagePaths ?? []).map((path) => ({ type: "localImage", path }))
    ];
    const turnStartTimeoutMs = runDeadline === void 0 ? TURN_START_TIMEOUT_MS : Math.max(1, Math.min(TURN_START_TIMEOUT_MS, runDeadline - Date.now()));
    let turnResult;
    turnStartSent = true;
    try {
      turnResult = await Promise.race([
        client.request("turn/start", {
          threadId,
          input,
          ...opts.model ? { model: opts.model } : {},
          ...opts.reasoningEffort ? { effort: opts.reasoningEffort } : {},
          ...opts.serviceTier !== void 0 ? { serviceTier: opts.serviceTier } : {},
          ...opts.sandboxPolicy ? { sandboxPolicy: opts.sandboxPolicy } : {}
        }, turnStartTimeoutMs),
        completion.then(() => {
          throw new CodexTurnError("Codex turn settled before turn/start was acknowledged");
        }),
        lifecycleFailure
      ]);
    } catch (error) {
      if ((error instanceof TimeoutError || error instanceof AbortError) && threadId) {
        if (turnId && !interruption) {
          void client.request("turn/interrupt", { threadId, turnId }).catch(() => {
          });
        }
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
    resolveTurnKnown(true);
    resolvePendingTurnError();
    if (interruption) requestInterrupt();
    const ackStatus = turnStatus(turnResult);
    const ackTerminal = ackStatus !== void 0 && ackStatus !== "completed" && ackStatus !== "inProgress" && ackStatus !== "in_progress";
    let exitCode = 0;
    if (ackTerminal && !settled) {
      settled = true;
      exitCode = 1;
    } else {
      await raceLifecycle(completion);
      if (ackTerminal) exitCode = 1;
    }
    return {
      text: finalText.trim(),
      exitCode,
      sessionId: threadId,
      ...latestUsage ? { usage: latestUsage } : {}
    };
  } finally {
    continuity?.onSteerable?.(null);
    resolveTurnKnown(false);
    if (timeout) clearTimeout(timeout);
    flushPendingWebTools();
    opts.signal?.removeEventListener("abort", abortHandler);
    removeNotification();
    removeClose();
    removeStderr();
    const finishedTurnId = turnId;
    if (finishedTurnId) safeCallback(() => continuity?.onTurnId?.(finishedTurnId));
    if (ownedClient) client.close();
  }
}
async function createCodexAppServerSession(options) {
  const client = await createCodexAppServerClient({
    cwd: options.cwd,
    ...options.executablePath ? { executablePath: options.executablePath } : {},
    ...options.env ? { env: options.env } : {},
    ...options.spawnFn ? { spawnFn: options.spawnFn } : {},
    ...options.requestTimeoutMs !== void 0 ? { requestTimeoutMs: options.requestTimeoutMs } : {}
  });
  let opened;
  try {
    opened = openedCodexThread(await requestCodexThread(client, options), options.model);
  } catch (error) {
    client.close();
    throw error;
  }
  let closed = false;
  let running = false;
  let steerRunning = null;
  const previousTurnIds = /* @__PURE__ */ new Set();
  let closePromise;
  client.onClose(() => {
    closed = true;
  });
  return {
    threadId: opened.threadId,
    cwd: options.cwd,
    get closed() {
      return closed;
    },
    async runTurn(turnOptions) {
      if (closed) throw new Error("Codex app-server session is closed");
      if (running) throw new Error("Codex app-server session already has an active turn");
      running = true;
      try {
        return await runCodexAppServerTurn({
          ...turnOptions,
          cwd: options.cwd,
          ...options.executablePath ? { executablePath: options.executablePath } : {},
          ...options.env ? { env: options.env } : {},
          ...options.spawnFn ? { spawnFn: options.spawnFn } : {},
          ...options.dangerouslyBypassApprovalsAndSandbox !== void 0 ? {
            dangerouslyBypassApprovalsAndSandbox: options.dangerouslyBypassApprovalsAndSandbox
          } : {},
          ...options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}
        }, client, opened, false, {
          previousTurnIds,
          onTurnId: (turnId) => {
            previousTurnIds.add(turnId);
          },
          onSteerable: (steer) => {
            steerRunning = steer;
          }
        }, true);
      } finally {
        running = false;
        steerRunning = null;
      }
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
      closePromise ??= clientExitPromises.get(client) ?? Promise.resolve();
      if (!closed) closed = true;
      client.close();
      return closePromise;
    }
  };
}
async function runCodexAppServer(opts) {
  if (opts.signal?.aborted) throw new AbortError("codex run aborted");
  const ownedClient = !opts.appServerClient;
  const client = opts.appServerClient ?? await createCodexAppServerClient({
    cwd: opts.cwd,
    ...opts.executablePath ? { executablePath: opts.executablePath } : {},
    ...opts.env ? { env: opts.env } : {},
    ...opts.spawnFn ? { spawnFn: opts.spawnFn } : {}
  });
  return runCodexAppServerTurn(opts, client, void 0, ownedClient);
}

// src/run-codex.ts
var CODEX_STRIPPED_ENV_VARS = ["CODEX_THREAD_ID"];
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
function execToolName(item) {
  if (item.type === "todo_list" || item.type === "plan_update") return "TodoWrite";
  return toolName(item);
}
function execPlanItems(item) {
  const values = Array.isArray(item.items) ? item.items : Array.isArray(item.plan) ? item.plan : void 0;
  if (!values) return void 0;
  const items = [];
  for (const value of values) {
    if (!isRecord(value)) return void 0;
    const text2 = normalizeSummary(value.text) ?? normalizeSummary(value.step);
    const status = typeof value.completed === "boolean" ? value.completed ? "completed" : "pending" : normalizePlanStatus(value.status);
    if (!text2 || !status) return void 0;
    items.push({ text: text2, status });
  }
  return items.length > 0 ? items : void 0;
}
function execToolSummary(item, planItems2) {
  if ((item.type === "todo_list" || item.type === "plan_update") && planItems2) {
    return planCompletionSummary(planItems2);
  }
  return summarizeTool(item);
}
function execUsage(usage, opts) {
  const input = toTokenCount(usage.input_tokens);
  const cached = toTokenCount(usage.cached_input_tokens);
  const output = toTokenCount(usage.output_tokens);
  if (input + output <= 0) return void 0;
  const contextWindow = opts.contextWindow ?? contextWindowForModel(opts.model);
  return {
    // Input side only (cached included), per the TokenUsage contract — not
    // app-server's totalTokens, which also counts output.
    contextTokens: input,
    inputTokens: Math.max(0, input - cached),
    cachedInputTokens: cached,
    outputTokens: output,
    ...opts.model ? { model: opts.model } : {},
    ...contextWindow !== void 0 ? { contextWindow } : {}
  };
}
function execFatalError(event) {
  if (event.type !== "error" && event.type !== "turn.failed") return void 0;
  const detail = typeof event.message === "string" ? event.message : typeof event.error === "string" ? event.error : isRecord(event.error) && typeof event.error.message === "string" ? event.error.message : void 0;
  return new CodexTurnError(detail ? `Codex error: ${detail}` : "Codex error");
}
async function runIsolatedCodex(opts) {
  const spawnFn = opts.spawnFn ?? spawn;
  let child;
  try {
    child = spawnFn(opts.executablePath ?? "codex", buildIsolatedArgs(opts), {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: filterEnv(opts.env ?? process.env, CODEX_STRIPPED_ENV_VARS),
      detached: process.platform !== "win32"
    });
  } catch (error) {
    if (error instanceof Error && isMissingExecutable(error)) throw new MissingCliError("codex");
    throw error;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let sessionId;
    let finalText = "";
    let latestUsage;
    let fatalError;
    const emittedTools = /* @__PURE__ */ new Set();
    const lifecycle = watchLifecycle({
      cli: "codex",
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      kill: (signal) => signalProcessTree(child, signal)
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
      if (settled) return;
      settled = true;
      lifecycle.cleanup();
      reject(isMissingExecutable(error) ? new MissingCliError("codex") : error);
    });
    child.on("close", (code) => {
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
  if (!opts.isolated) {
    if (opts.appServerClient && opts.appServerSession) {
      throw new Error("Codex runs cannot use both appServerClient and appServerSession");
    }
    if (opts.appServerSession) {
      if (opts.resumeSessionId) {
        throw new Error("Session-backed Codex runs cannot resume another session");
      }
      if (opts.developerInstructions !== void 0 || opts.dangerouslyBypassApprovalsAndSandbox !== void 0 || opts.env !== void 0 || opts.executablePath !== void 0 || opts.spawnFn !== void 0) {
        throw new Error("Session-backed Codex runs cannot override thread or client options");
      }
      if (opts.cwd !== opts.appServerSession.cwd) {
        throw new Error("Codex run cwd must match the app-server session cwd");
      }
      return opts.appServerSession.runTurn(opts);
    }
    return runCodexAppServer(opts);
  }
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
  if (opts.serviceTier !== void 0) {
    throw new Error("isolated Codex runs cannot set a service tier \u2014 codex exec has no equivalent");
  }
  return runIsolatedCodex(opts);
}

// src/model-catalog.ts
import { execFile } from "child_process";
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
  return new Promise((resolve, reject) => {
    execFile(
      executablePath,
      ["--help"],
      {
        cwd,
        timeout: 5e3,
        maxBuffer: 1e6,
        // Same nesting-guard strip every other claude spawn applies, so
        // discovery still works for hosts running inside a Claude Code
        // session instead of silently degrading to the static fallback.
        env: filterEnv(process.env, CLAUDE_STRIPPED_ENV_VARS)
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
import { execFile as execFile2 } from "child_process";
var CHECK_TIMEOUT_MS = 5e3;
var APPLY_TIMEOUT_MS = 10 * 60 * 1e3;
var CLAUDE_RELEASE_BASE_URL = "https://downloads.claude.ai/claude-code-releases";
function defaultRunCommand(executable, args, options) {
  return new Promise((resolve, reject) => {
    execFile2(
      executable,
      [...args],
      {
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
        if (typeof error.code === "number") {
          resolve({ stdout, stderr, exitCode: error.code });
          return;
        }
        reject(Object.assign(error, { stdout, stderr }));
      }
    );
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
    const env = filterEnv(baseEnv, CLAUDE_STRIPPED_ENV_VARS);
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
    const env = filterEnv(baseEnv, CODEX_STRIPPED_ENV_VARS);
    const [installed, doctorResult] = await Promise.all([
      installedVersion("codex", executable, env, checkedAt),
      runCommand(executable, ["doctor", "--json"], { env, timeoutMs: CHECK_TIMEOUT_MS }).then((value) => ({ ok: true, value })).catch(() => ({ ok: false }))
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
    const env = filterEnv(
      baseEnv,
      provider === "claude" ? CLAUDE_STRIPPED_ENV_VARS : CODEX_STRIPPED_ENV_VARS
    );
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
  CLAUDE_FOLLOW_UP_GRACE_MS,
  CLAUDE_INTERRUPT_GRACE_MS,
  CLAUDE_STRIPPED_ENV_VARS,
  CODEX_STRIPPED_ENV_VARS,
  CodexTurnError,
  KNOWN_CONTEXT_WINDOWS,
  MissingCliError,
  SteerRejectedError,
  TimeoutError,
  collectCodexModels,
  contextWindowForModel,
  createClaudeSession,
  createClaudeTurnTranslator,
  createCodexAppServerClient,
  createCodexAppServerSession,
  createModelCatalogService,
  createProviderUpdateService,
  parseClaudeCliHelp,
  runClaude,
  runCodex
};
//# sourceMappingURL=index.js.map