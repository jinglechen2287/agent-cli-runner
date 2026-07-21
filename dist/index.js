// src/run-claude.ts
import { spawn as nodeSpawn2 } from "child_process";

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

// src/internal.ts
import { spawn as nodeSpawn } from "child_process";
import { StringDecoder } from "string_decoder";
var SIGTERM_GRACE_MS = 2e3;
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
  return "code" in error && error.code === "ENOENT";
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
    return /\[1m\]|[-_]1m\b/.test(id) ? CLAUDE_1M_CONTEXT_WINDOW : CLAUDE_DEFAULT_CONTEXT_WINDOW;
  }
  if (id.startsWith("gpt-5.6")) return 372e3;
  if (id.startsWith("gpt-5")) return 272e3;
  return void 0;
}

// src/run-claude.ts
var CLAUDE_STRIPPED_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN"
];
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
function planCompletionSummary(planItems2) {
  const completed = planItems2.filter((item) => item.status === "completed").length;
  return `${completed}/${planItems2.length} steps completed`;
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
function pickPrimaryModel(modelUsage, preferred) {
  if (!modelUsage) return void 0;
  const entries = Object.entries(modelUsage);
  if (entries.length === 0) return void 0;
  if (preferred) {
    const base = baseModelId(preferred);
    const match = entries.find(([key]) => baseModelId(key) === base);
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
async function runClaude(opts) {
  if (opts.newSessionId && opts.resumeSessionId) {
    throw new Error(
      "newSessionId and resumeSessionId are mutually exclusive \u2014 pass one or the other"
    );
  }
  if (opts.isolated && opts.resumeSessionId) {
    throw new Error("isolated Claude runs cannot resume a session");
  }
  const spawnFn = opts.spawnFn ?? nodeSpawn2;
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (opts.isolated) {
    args.push(
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence"
    );
  }
  if (opts.appendSystemPrompt) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }
  if (opts.newSessionId) {
    args.push("--session-id", opts.newSessionId);
  } else if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }
  const child = spawnFn(opts.executablePath ?? "claude", args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: filterEnv(opts.env ?? process.env, CLAUDE_STRIPPED_ENV_VARS)
  });
  writePrompt(child, opts.prompt);
  return new Promise((resolve, reject) => {
    let settled = false;
    let sessionId;
    let sessionIdEmitted = false;
    let lastAssistantText;
    let resultText;
    let lastAssistantModel;
    let lastMessageUsage;
    let lastUsage;
    const agentToolCallIds = /* @__PURE__ */ new Set();
    const backgroundAgents = /* @__PURE__ */ new Map();
    const emitBackgroundAgent = (agent) => {
      backgroundAgents.set(agent.id, agent);
      try {
        opts.onBackgroundAgentUpdate?.(agent);
      } catch {
      }
    };
    const emitUsage = (usage) => {
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
        }
      }
    });
    const emitSessionId = (id) => {
      sessionId = id;
      if (sessionIdEmitted) return;
      sessionIdEmitted = true;
      opts.onSessionId?.(id);
    };
    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (parsed.type === "system" && parsed.subtype === "init" && parsed.session_id) {
        emitSessionId(parsed.session_id);
        return;
      }
      if (parsed.type === "system" && parsed.subtype === "task_started" && typeof parsed.task_id === "string") {
        const isAgent = parsed.task_type === "local_agent" || parsed.task_type === "remote_agent" || typeof parsed.tool_use_id === "string" && agentToolCallIds.has(parsed.tool_use_id);
        if (!isAgent) return;
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
          status: "running",
          updatedAt: Date.now()
        });
        return;
      }
      if (parsed.type === "system" && parsed.subtype === "task_updated" && typeof parsed.task_id === "string") {
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
            opts.onToolUse?.({
              ...typeof block.id === "string" ? { callId: block.id } : {},
              name: block.name,
              ...summary !== void 0 ? { summary } : {},
              ...block.input ? { input: block.input } : {},
              ...planItems2 ? { planItems: planItems2 } : {}
            });
          }
        }
        if (texts.length > 0) {
          const text2 = texts.join("");
          lastAssistantText = text2;
          opts.onAssistantText?.(text2);
        }
        const model = parsed.message.model;
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
          opts.onToolResult?.({
            callId: block.tool_use_id,
            content: block.content,
            ...typeof block.is_error === "boolean" ? { isError: block.is_error } : {}
          });
        }
        return;
      }
      if (parsed.type === "result") {
        if (parsed.session_id) emitSessionId(parsed.session_id);
        if (typeof parsed.result === "string") resultText = parsed.result;
        const occupancy = lastMessageUsage ?? parsed.usage;
        if (occupancy) {
          const primary = pickPrimaryModel(parsed.modelUsage, lastAssistantModel);
          const model = primary?.model ?? lastAssistantModel;
          const contextWindow = primary?.contextWindow ?? contextWindowForModel(model);
          emitUsage(toClaudeUsage(occupancy, model, contextWindow));
        }
      }
    };
    const splitter = createLineSplitter(handleLine);
    child.stdout?.on("data", (chunk) => splitter.push(chunk));
    child.stderr?.on("data", (chunk) => {
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
        ...sessionId !== void 0 ? { sessionId } : {},
        ...lastUsage !== void 0 ? { usage: lastUsage } : {}
      });
    });
  });
}

// src/run-codex.ts
import { spawn } from "child_process";

// src/codex-app-server.ts
import { spawn as nodeSpawn3 } from "child_process";
var DEFAULT_REQUEST_TIMEOUT_MS = 1e4;
var TURN_START_TIMEOUT_MS = 6e4;
var CLIENT_INFO = {
  name: "agent_cli_runner",
  title: "Agent CLI Runner",
  version: "0.1.0"
};
var clientExitPromises = /* @__PURE__ */ new WeakMap();
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function rpcError(value, fallback) {
  if (!isRecord(value)) return new Error(fallback);
  const message = typeof value.message === "string" ? value.message : fallback;
  const error = new Error(message);
  if (value.code !== void 0) error.code = value.code;
  if (value.data !== void 0) error.data = value.data;
  return error;
}
function safeCallback(use) {
  try {
    use();
  } catch {
  }
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
  const serverRequestHandlers = /* @__PURE__ */ new Set();
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
    const handler = serverRequestHandlers.values().next().value;
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
  child.stderr?.on("data", (chunk) => {
    const text2 = chunk.toString();
    stderr = (stderr + text2).slice(-4e3);
    for (const handler of stderrHandlers) safeCallback(() => handler(text2));
  });
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
      serverRequestHandlers.add(handler);
      return () => serverRequestHandlers.delete(handler);
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
      capabilities: { experimentalApi: false }
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
      return webActionType(item) === "open_page" || webActionType(item) === "find_in_page" ? "WebFetch" : "WebSearch";
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
  const url = text(action?.url) ?? text(item.url);
  if (actionType === "open_page" && url) {
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
      const url = text(action?.url) ?? text(item.url);
      if (actionType === "open_page") return url ?? webSearchQuery(item);
      if (actionType === "find_in_page") {
        const pattern = text(action?.pattern) ?? text(item.pattern);
        if (pattern && url) return `${pattern} \xB7 ${url}`;
        return pattern ?? url ?? webSearchQuery(item);
      }
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
function normalizePlanStatus(value) {
  const status = text(value);
  if (!status) return void 0;
  return status.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/\s+/g, "_");
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
  const completed = items.filter(({ status }) => status === "completed").length;
  return {
    callId: `${turnId}:plan`,
    name: "TodoWrite",
    summary: `${completed}/${items.length} steps completed`,
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
  const used = toTokenCount(last.totalTokens);
  if (used <= 0) return void 0;
  const input = toTokenCount(last.inputTokens);
  const cached = toTokenCount(last.cachedInputTokens);
  const contextWindow = toContextWindow(tokenUsage?.modelContextWindow) ?? fallbackWindow;
  return {
    contextTokens: used,
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
  return opts.resumeSessionId ? client.request("thread/resume", {
    threadId: opts.resumeSessionId,
    cwd: opts.cwd,
    ...opts.model ? { model: opts.model } : {},
    ...opts.developerInstructions ? { developerInstructions: opts.developerInstructions } : {},
    ...opts.dangerouslyBypassApprovalsAndSandbox ? { approvalPolicy: "never", sandbox: "danger-full-access" } : {}
  }) : client.request("thread/start", {
    cwd: opts.cwd,
    ...opts.model ? { model: opts.model } : {},
    ...opts.developerInstructions ? { developerInstructions: opts.developerInstructions } : {},
    ...opts.dangerouslyBypassApprovalsAndSandbox ? { approvalPolicy: "never", sandbox: "danger-full-access" } : {}
  });
}
function openedCodexThread(value, fallbackModel) {
  const threadId = threadIdFrom(value);
  if (!threadId) throw new CodexTurnError("Codex app-server did not return a thread ID");
  const model = text(record(value)?.model) ?? fallbackModel;
  return { threadId, ...model ? { model } : {} };
}
async function runCodexAppServerTurn(opts, client, openedThread, ownedClient = false, continuity) {
  if (opts.signal?.aborted) throw new AbortError("codex run aborted");
  const isPreviousTurn = (turnId2) => continuity?.previousTurnIds?.has(turnId2) ?? false;
  let threadId = openedThread?.threadId ?? opts.resumeSessionId;
  let turnId;
  let resolvedModel = opts.model ?? openedThread?.model;
  let finalText = "";
  let latestUsage;
  let settled = false;
  let interruption;
  let timeout;
  const emittedTools = /* @__PURE__ */ new Set();
  const backgroundAgents = /* @__PURE__ */ new Map();
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
    const eventTurnId = text(params.turnId);
    if (!eventTurnId || isPreviousTurn(eventTurnId)) return;
    turnId ??= eventTurnId;
    if (turnId !== eventTurnId) return;
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
    const name = toolName(item);
    if (!name) return;
    const id = text(item.id) ?? `${itemType(item)}:${name}`;
    if (!emittedTools.has(id)) {
      emittedTools.add(id);
      const summary = summarizeTool(item);
      safeCallback(() => opts.onToolUse?.({
        callId: id,
        name,
        ...summary ? { summary } : {},
        input: toolInput(item)
      }));
    }
    if (method === "item/completed") {
      const exitCode = item.exitCode;
      const status = text(item.status);
      safeCallback(() => opts.onToolResult?.({
        callId: id,
        content: item,
        ...typeof exitCode === "number" && exitCode !== 0 || status === "failed" ? { isError: true } : {}
      }));
    }
  };
  const removeNotification = client.onNotification((method, rawParams) => {
    const params = record(rawParams);
    if (!params) return;
    if (method === "turn/started" && params.threadId === threadId) {
      const startedTurnId = text(record(params.turn)?.id);
      if (startedTurnId && !isPreviousTurn(startedTurnId)) turnId ??= startedTurnId;
      if (interruption) requestInterrupt();
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      handleItem(method, params);
      return;
    }
    if (method === "turn/plan/updated" && params.threadId === threadId) {
      const eventTurnId = text(params.turnId);
      if (!eventTurnId || isPreviousTurn(eventTurnId) || turnId && eventTurnId !== turnId) {
        return;
      }
      turnId ??= eventTurnId;
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
      const message2 = text(record(params.error)?.message) ?? "Codex turn failed";
      settleError(new CodexTurnError(`Codex error: ${message2}`));
      return;
    }
    if (method !== "turn/completed" || params.threadId !== threadId) return;
    const completedTurnId = text(record(params.turn)?.id);
    if (!completedTurnId || isPreviousTurn(completedTurnId) || turnId && completedTurnId !== turnId) {
      return;
    }
    turnId ??= completedTurnId;
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
    try {
      turnResult = await raceLifecycle(client.request("turn/start", {
        threadId,
        input,
        ...opts.model ? { model: opts.model } : {},
        ...opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}
      }, turnStartTimeoutMs));
    } catch (error) {
      if ((error instanceof TimeoutError || error instanceof AbortError) && threadId) {
        if (turnId && !interruption) {
          void client.request("turn/interrupt", { threadId, turnId }).catch(() => {
          });
        }
        client.close();
      }
      throw error;
    }
    turnId = turnIdFrom(turnResult) ?? turnId;
    if (!turnId) throw new CodexTurnError("Codex app-server did not return a turn ID");
    if (interruption) requestInterrupt();
    await raceLifecycle(completion);
    const status = turnStatus(turnResult);
    return {
      text: finalText.trim(),
      exitCode: status && status !== "completed" && status !== "inProgress" ? 1 : 0,
      sessionId: threadId,
      ...latestUsage ? { usage: latestUsage } : {}
    };
  } finally {
    if (timeout) clearTimeout(timeout);
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
          }
        });
      } finally {
        running = false;
      }
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
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
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
  for (const path of opts.imagePaths ?? []) args.push("-i", path);
  args.push("-");
  return args;
}
function execToolName(item) {
  switch (item.type) {
    case "command_execution":
      return "Bash";
    case "file_change":
      return "Edit";
    case "mcp_tool_call":
      return typeof item.tool === "string" ? item.tool : "MCP";
    case "web_search":
      return "WebSearch";
    case "todo_list":
    case "plan_update":
      return "TodoWrite";
    default:
      return null;
  }
}
function execWebQuery(item) {
  const direct = normalizeSummary(item.query);
  if (direct) return direct;
  if (!isRecord2(item.action)) return void 0;
  const query = normalizeSummary(item.action.query);
  if (query) return query;
  if (!Array.isArray(item.action.queries)) return void 0;
  for (const candidate of item.action.queries) {
    const normalized = normalizeSummary(candidate);
    if (normalized) return normalized;
  }
  return void 0;
}
function execPlanItems(item) {
  const values = Array.isArray(item.items) ? item.items : Array.isArray(item.plan) ? item.plan : void 0;
  if (!values) return void 0;
  const items = [];
  for (const value of values) {
    if (!isRecord2(value)) return void 0;
    const text2 = normalizeSummary(value.text) ?? normalizeSummary(value.step);
    const rawStatus = typeof value.completed === "boolean" ? value.completed ? "completed" : "pending" : normalizeSummary(value.status);
    const status = rawStatus?.toLowerCase().replace(/\s+/g, "_");
    if (!text2 || !status) return void 0;
    items.push({ text: text2, status });
  }
  return items.length > 0 ? items : void 0;
}
function execToolSummary(item, planItems2) {
  if (item.type === "command_execution") return normalizeSummary(item.command);
  if (item.type === "web_search") return execWebQuery(item);
  if (item.type === "file_change" && Array.isArray(item.changes)) {
    const paths = item.changes.flatMap((change) => {
      const path = isRecord2(change) ? normalizeSummary(change.path) : void 0;
      return path ? [path] : [];
    });
    if (paths.length === 1) return paths[0];
    if (paths.length > 1) return `${paths.length} files`;
  }
  if ((item.type === "todo_list" || item.type === "plan_update") && planItems2) {
    const complete = planItems2.filter(({ status }) => status === "completed").length;
    return `${complete}/${planItems2.length} steps completed`;
  }
  return void 0;
}
function execFatalError(event) {
  if (event.type !== "error" && event.type !== "turn.failed") return void 0;
  const detail = typeof event.message === "string" ? event.message : typeof event.error === "string" ? event.error : isRecord2(event.error) && typeof event.error.message === "string" ? event.error.message : void 0;
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
        sessionId = event.thread_id;
        opts.onSessionId?.(event.thread_id);
        return;
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        finalText = event.item.text;
        opts.onAssistantText?.(event.item.text);
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
        opts.onToolUse?.({
          callId: id,
          name,
          ...summary ? { summary } : {},
          ...planItems2 ? { planItems: planItems2 } : {},
          input: item.type === "web_search" ? { ...item, query: execWebQuery(item) } : item
        });
      }
      if (event.type === "item.completed") {
        opts.onToolResult?.({ callId: id, content: item });
      }
    };
    const splitter = createLineSplitter(handleLine);
    child.stdout?.on("data", (chunk) => splitter.push(chunk));
    child.stderr?.on("data", (chunk) => opts.onStderr?.(chunk.toString()));
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
        ...sessionId ? { sessionId } : {}
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
  return runIsolatedCodex(opts);
}
export {
  AbortError,
  CLAUDE_STRIPPED_ENV_VARS,
  CODEX_STRIPPED_ENV_VARS,
  CodexTurnError,
  KNOWN_CONTEXT_WINDOWS,
  MissingCliError,
  TimeoutError,
  contextWindowForModel,
  createCodexAppServerClient,
  createCodexAppServerSession,
  runClaude,
  runCodex
};
//# sourceMappingURL=index.js.map