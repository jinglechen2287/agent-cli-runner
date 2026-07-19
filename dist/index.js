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
    if (match) return { model: match[0], contextWindow: match[1].contextWindow };
  }
  let best = entries[0];
  for (const entry of entries) {
    if ((entry[1].contextWindow ?? 0) > (best[1].contextWindow ?? 0)) best = entry;
  }
  return { model: best[0], contextWindow: best[1].contextWindow };
}
async function runClaude(opts) {
  if (opts.newSessionId && opts.resumeSessionId) {
    throw new Error(
      "newSessionId and resumeSessionId are mutually exclusive \u2014 pass one or the other"
    );
  }
  const spawnFn = opts.spawnFn ?? nodeSpawn2;
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
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
    let lastUsage;
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
      if (parsed.type === "assistant" && parsed.message?.content) {
        const texts = [];
        for (const block of parsed.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            texts.push(block.text);
          } else if (block.type === "tool_use" && typeof block.name === "string") {
            const summary = summarizeClaudeTool(block.name, block.input);
            opts.onToolUse?.({
              name: block.name,
              ...summary !== void 0 ? { summary } : {},
              ...block.input ? { input: block.input } : {}
            });
          }
        }
        if (texts.length > 0) {
          const text = texts.join("");
          lastAssistantText = text;
          opts.onAssistantText?.(text);
        }
        const model = parsed.message.model;
        if (model) lastAssistantModel = model;
        if (parsed.message.usage) {
          emitUsage(
            toClaudeUsage(parsed.message.usage, model, contextWindowForModel(model))
          );
        }
        return;
      }
      if (parsed.type === "result") {
        if (parsed.session_id) emitSessionId(parsed.session_id);
        if (typeof parsed.result === "string") resultText = parsed.result;
        if (parsed.usage) {
          const primary = pickPrimaryModel(parsed.modelUsage, lastAssistantModel);
          const model = primary?.model ?? lastAssistantModel;
          const contextWindow = primary?.contextWindow ?? contextWindowForModel(model);
          emitUsage(toClaudeUsage(parsed.usage, model, contextWindow));
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
import { spawn as nodeSpawn3 } from "child_process";
var CODEX_STRIPPED_ENV_VARS = ["CODEX_THREAD_ID"];
function toolName(item) {
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
function summarizeCodexTool(item) {
  switch (item.type) {
    case "command_execution":
      return normalizeSummary(item.command);
    case "web_search":
      return normalizeSummary(item.query);
    case "file_change": {
      if (!Array.isArray(item.changes)) return void 0;
      const paths = item.changes.map(
        (change) => change && typeof change === "object" ? normalizeSummary(change.path) : void 0
      ).filter((path) => path !== void 0);
      if (paths.length === 1) return paths[0];
      if (paths.length > 1) return `${paths.length} files`;
      return void 0;
    }
    default:
      return void 0;
  }
}
function fatalEventError(event) {
  if (event.type !== "error" && event.type !== "turn.failed") return null;
  let detail;
  if (typeof event.message === "string") {
    detail = event.message;
  } else if (typeof event.error === "string") {
    detail = event.error;
  } else if (event.error && typeof event.error === "object") {
    const message = event.error.message;
    if (typeof message === "string") detail = message;
  }
  const label = event.type === "turn.failed" ? "Codex turn failed" : "Codex error";
  return new CodexTurnError(detail ? `${label}: ${detail}` : label);
}
function buildArgs(opts) {
  const args = opts.resumeSessionId ? ["exec", "resume", "--json"] : ["exec", "--json"];
  if (opts.dangerouslyBypassApprovalsAndSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  args.push("--skip-git-repo-check");
  if (opts.model !== void 0) {
    args.push("--model", opts.model);
  }
  if (opts.developerInstructions !== void 0) {
    args.push("-c", `developer_instructions=${JSON.stringify(opts.developerInstructions)}`);
  }
  for (const imagePath of opts.imagePaths ?? []) {
    args.push("-i", imagePath);
  }
  if (opts.resumeSessionId) args.push(opts.resumeSessionId);
  args.push("-");
  return args;
}
async function runCodex(opts) {
  const spawnFn = opts.spawnFn ?? nodeSpawn3;
  const child = spawnFn(opts.executablePath ?? "codex", buildArgs(opts), {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: filterEnv(opts.env ?? process.env, CODEX_STRIPPED_ENV_VARS),
    detached: process.platform !== "win32"
  });
  writePrompt(child, opts.prompt);
  return new Promise((resolve, reject) => {
    let settled = false;
    let sessionId;
    let finalText;
    let fatalError;
    let lastUsage;
    const emittedTools = /* @__PURE__ */ new Set();
    const contextWindow = opts.contextWindow ?? contextWindowForModel(opts.model);
    const lifecycle = watchLifecycle({
      cli: "codex",
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      kill: (signal) => signalProcessTree(child, signal)
    });
    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      const eventError = fatalEventError(event);
      if (eventError) {
        fatalError ??= eventError;
        return;
      }
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        sessionId = event.thread_id;
        opts.onSessionId?.(event.thread_id);
        return;
      }
      if (event.type === "turn.completed" && event.usage) {
        const input = toTokenCount(event.usage.input_tokens);
        const cached = toTokenCount(event.usage.cached_input_tokens);
        const usage = {
          contextTokens: input,
          inputTokens: Math.max(0, input - cached),
          cachedInputTokens: cached,
          outputTokens: toTokenCount(event.usage.output_tokens) + toTokenCount(event.usage.reasoning_output_tokens),
          ...opts.model ? { model: opts.model } : {},
          ...contextWindow !== void 0 ? { contextWindow } : {}
        };
        lastUsage = usage;
        opts.onUsage?.(usage);
        return;
      }
      if (event.type !== "item.started" && event.type !== "item.completed") {
        return;
      }
      const item = event.item;
      if (!item) return;
      if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
        finalText = item.text;
        opts.onAssistantText?.(item.text);
        return;
      }
      const name = toolName(item);
      if (!name) return;
      const id = typeof item.id === "string" ? item.id : `${item.type}:${name}`;
      if (emittedTools.has(id)) return;
      emittedTools.add(id);
      const summary = summarizeCodexTool(item);
      opts.onToolUse?.({
        name,
        ...summary !== void 0 ? { summary } : {},
        input: item
      });
    };
    const splitter = createLineSplitter(handleLine);
    child.stdout?.on("data", (chunk) => splitter.push(chunk));
    child.stderr?.on("data", (chunk) => {
      opts.onStderr?.(chunk.toString());
    });
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
        text: (finalText ?? "").trim(),
        exitCode: code ?? -1,
        ...sessionId !== void 0 ? { sessionId } : {},
        ...lastUsage !== void 0 ? { usage: lastUsage } : {}
      });
    });
  });
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
  runClaude,
  runCodex
};
//# sourceMappingURL=index.js.map