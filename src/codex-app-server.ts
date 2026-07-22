import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { AbortError, CodexTurnError, MissingCliError, TimeoutError } from "./errors.js";
import {
  createLineSplitter,
  filterEnv,
  isMissingExecutable,
  normalizeSummary,
  SIGTERM_GRACE_MS,
  signalProcessTree,
  toContextWindow,
  toTokenCount,
} from "./internal.js";
import type { RunCodexOptions } from "./run-codex.js";
import type {
  BackgroundAgentInfo,
  BackgroundAgentStatus,
  RunResult,
  ToolPlanItem,
  ToolUseInfo,
  UserInputQuestion,
  UserInputRequest,
} from "./types.js";
import type { TokenUsage } from "./usage.js";

interface JsonRpcMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexServerRequest {
  id: number | string;
  method: string;
  params: unknown;
}

export type CodexServerRequestHandler = (
  request: CodexServerRequest,
) => Promise<unknown> | unknown;

export interface CodexAppServerClient {
  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
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

export interface CreateCodexAppServerClientOptions {
  executablePath?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: RunCodexOptions["spawnFn"];
  requestTimeoutMs?: number;
}

export type CodexAppServerTurnOptions = Omit<
  RunCodexOptions,
  | "appServerClient"
  | "appServerSession"
  | "cwd"
  | "dangerouslyBypassApprovalsAndSandbox"
  | "developerInstructions"
  | "env"
  | "executablePath"
  | "isolated"
  | "resumeSessionId"
  | "spawnFn"
>;

export interface CodexAppServerSession {
  readonly threadId: string;
  readonly cwd: string;
  readonly closed: boolean;
  runTurn(options: CodexAppServerTurnOptions): Promise<RunResult>;
  onClose(handler: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export interface CreateCodexAppServerSessionOptions {
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

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** `turn/start` is acked immediately in normal operation, but a busy
 * app-server can be slow to answer; give it far more headroom than plain
 * admin requests so a loaded host does not fail turns spuriously. */
const TURN_START_TIMEOUT_MS = 60_000;
const CLIENT_INFO = {
  name: "agent_cli_runner",
  title: "Agent CLI Runner",
  version: "0.1.0",
};
const clientExitPromises = new WeakMap<CodexAppServerClient, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rpcError(value: unknown, fallback: string): Error {
  if (!isRecord(value)) return new Error(fallback);
  const message = typeof value.message === "string" ? value.message : fallback;
  const error = new Error(message) as Error & { code?: unknown; data?: unknown };
  if (value.code !== undefined) error.code = value.code;
  if (value.data !== undefined) error.data = value.data;
  return error;
}

function safeCallback(use: () => void): void {
  try {
    use();
  } catch {
    // Host callbacks must never corrupt the provider stream.
  }
}

export async function createCodexAppServerClient(
  options: CreateCodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  const spawnFn = options.spawnFn ?? nodeSpawn;
  let child: ChildProcess;
  try {
    child = spawnFn(options.executablePath ?? "codex", ["app-server", "--stdio"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: filterEnv(options.env ?? process.env, ["CODEX_THREAD_ID"]),
      detached: process.platform !== "win32",
    });
  } catch (error) {
    if (error instanceof Error && isMissingExecutable(error)) throw new MissingCliError("codex");
    throw error;
  }

  const pending = new Map<number, PendingRequest>();
  const notificationHandlers = new Set<(method: string, params: unknown) => void>();
  const serverRequestHandlers = new Map<string, Set<CodexServerRequestHandler>>();
  const stderrHandlers = new Set<(chunk: string) => void>();
  const closeHandlers = new Set<(error: Error) => void>();
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let nextId = 1;
  let closed = false;
  let closeError: Error | undefined;
  let childExited = false;
  let terminationRequested = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let exitFallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let stderr = "";
  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const send = (message: Record<string, unknown>): void => {
    if (closed) return;
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };

  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  const fail = (error: Error): void => {
    if (closed) return;
    closed = true;
    closeError = error;
    rejectPending(error);
    for (const handler of closeHandlers) safeCallback(() => handler(error));
  };

  const respondToServerRequest = async (message: JsonRpcMessage): Promise<void> => {
    const id = message.id;
    const method = message.method;
    if ((typeof id !== "number" && typeof id !== "string") || typeof method !== "string") return;
    const handlers = serverRequestHandlers.get(method);
    if (!handlers || handlers.size === 0) {
      send({
        id,
        error: { code: -32601, message: `Unsupported server request: ${method}` },
      });
      return;
    }
    for (const handler of handlers) {
      try {
        const result = await handler({ id, method, params: message.params });
        if (result === undefined) continue;
        send({ id, result });
        return;
      } catch (error) {
        send({
          id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Server request handler failed",
          },
        });
        return;
      }
    }
    send({
      id,
      error: { code: -32601, message: `Unsupported server request: ${method}` },
    });
  };

  const handleLine = (line: string): void => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    if (typeof message.method === "string" && message.id !== undefined) {
      void respondToServerRequest(message);
      return;
    }
    if (typeof message.method === "string") {
      for (const handler of notificationHandlers) {
        safeCallback(() => handler(message.method as string, message.params));
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error !== undefined) {
      request.reject(rpcError(message.error, "Codex app-server request failed"));
    } else {
      request.resolve(message.result);
    }
  };

  const splitter = createLineSplitter(handleLine);
  child.stdout?.on("data", (chunk: Buffer | string) => splitter.push(chunk));
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    stderr = (stderr + text).slice(-4_000);
    for (const handler of stderrHandlers) safeCallback(() => handler(text));
  });
  child.stdin?.on("error", (error: Error) => fail(error));
  child.stdout?.on("error", (error: Error) => fail(error));
  child.stderr?.on("error", (error: Error) => fail(error));
  child.on("error", (error: Error) => {
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
      `Codex app-server exited${code === null ? "" : ` with code ${code}`}${detail ? `: ${detail}` : ""}`,
    ));
  });

  const client: CodexAppServerClient = {
    request(method, params = {}, requestTimeoutMs) {
      if (closed) return Promise.reject(new Error("Codex app-server is closed"));
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
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
    onServerRequest(method, handler) {
      const handlers = serverRequestHandlers.get(method) ?? new Set<CodexServerRequestHandler>();
      handlers.add(handler);
      serverRequestHandlers.set(method, handlers);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) serverRequestHandlers.delete(method);
      };
    },
    onStderr(handler) {
      stderrHandlers.add(handler);
      return () => stderrHandlers.delete(handler);
    },
    onClose(handler) {
      if (closed) {
        safeCallback(() => handler(closeError ?? new Error("Codex app-server is closed")));
        return () => {};
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
    },
  };
  clientExitPromises.set(client, exitPromise);

  try {
    await client.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function codexUserInputQuestion(value: unknown): UserInputQuestion {
  const question = record(value);
  const id = text(question?.id);
  const header = text(question?.header);
  const prompt = text(question?.question);
  if (!question || !id || !header || !prompt) {
    throw new Error("Malformed Codex user-input question");
  }
  const rawOptions = question.options;
  if (rawOptions !== null && rawOptions !== undefined && !Array.isArray(rawOptions)) {
    throw new Error(`Malformed Codex options for question ${id}`);
  }
  const options = (rawOptions ?? []).map((value) => {
    const option = record(value);
    const label = text(option?.label);
    if (!option || !label) throw new Error(`Malformed Codex option for question ${id}`);
    if (
      option.description !== undefined
      && option.description !== null
      && typeof option.description !== "string"
    ) {
      throw new Error(`Malformed Codex option for question ${id}`);
    }
    const description = text(option.description);
    return { label, ...(description ? { description } : {}) };
  });
  if (question.isOther !== undefined && typeof question.isOther !== "boolean") {
    throw new Error(`Malformed Codex isOther for question ${id}`);
  }
  if (question.isSecret !== undefined && typeof question.isSecret !== "boolean") {
    throw new Error(`Malformed Codex isSecret for question ${id}`);
  }
  return {
    id,
    header,
    question: prompt,
    options,
    multiSelect: false,
    allowOther: question.isOther === true,
    secret: question.isSecret === true,
  };
}

function codexUserInputRequest(value: unknown): {
  threadId: string;
  turnId: string;
  request: UserInputRequest;
} {
  const params = record(value);
  const threadId = text(params?.threadId);
  const turnId = text(params?.turnId);
  const requestId = text(params?.itemId);
  if (!params || !threadId || !turnId || !requestId || !Array.isArray(params.questions)) {
    throw new Error("Malformed Codex user-input request");
  }
  const questions = params.questions.map(codexUserInputQuestion);
  if (questions.length === 0) throw new Error("Codex user-input request has no questions");
  if (new Set(questions.map(({ id }) => id)).size !== questions.length) {
    throw new Error("Codex user-input request has duplicate question IDs");
  }
  const autoResolutionMs = params.autoResolutionMs;
  if (
    autoResolutionMs !== undefined
    && autoResolutionMs !== null
    && (!Number.isSafeInteger(autoResolutionMs) || (autoResolutionMs as number) < 0)
  ) {
    throw new Error("Malformed Codex user-input auto-resolution timeout");
  }
  return {
    threadId,
    turnId,
    request: {
      requestId,
      questions,
      ...(typeof autoResolutionMs === "number" ? { autoResolutionMs } : {}),
    },
  };
}

function property(item: Record<string, unknown>, camel: string, snake: string): unknown {
  return item[camel] ?? item[snake];
}

function itemType(item: Record<string, unknown>): string | undefined {
  return text(item.type);
}

function webAction(item: Record<string, unknown>): Record<string, unknown> | undefined {
  return record(item.action);
}

function webActionType(item: Record<string, unknown>): string | undefined {
  const type = text(webAction(item)?.type);
  if (type === "openPage") return "open_page";
  if (type === "findInPage") return "find_in_page";
  return type;
}

function isWebItem(item: Record<string, unknown>): boolean {
  const type = itemType(item);
  return type === "webSearch" || type === "web_search";
}

function webUrl(item: Record<string, unknown>): string | undefined {
  return text(webAction(item)?.url) ?? text(item.url);
}

function toolName(item: Record<string, unknown>): string | null {
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
      return webActionType(item) === "open_page"
        || webActionType(item) === "find_in_page"
        || webActionType(item) === "other"
        ? "WebFetch"
        : "WebSearch";
    default:
      return null;
  }
}

function webSearchQuery(item: Record<string, unknown>): string | undefined {
  const direct = normalizeSummary(item.query);
  if (direct) return direct;
  const action = record(item.action);
  const query = normalizeSummary(action?.query);
  if (query) return query;
  if (!Array.isArray(action?.queries)) return undefined;
  for (const candidate of action.queries) {
    const normalized = normalizeSummary(candidate);
    if (normalized) return normalized;
  }
  return undefined;
}

function toolInput(item: Record<string, unknown>): Record<string, unknown> {
  const type = itemType(item);
  if (type !== "webSearch" && type !== "web_search") return item;
  const action = webAction(item);
  const actionType = webActionType(item);
  const url = webUrl(item);
  if ((actionType === "open_page" || actionType === "other") && url) {
    const input: Record<string, unknown> = { ...item, url };
    delete input.query;
    return input;
  }
  const pattern = text(action?.pattern) ?? text(item.pattern);
  if (actionType === "find_in_page" && (url || pattern)) {
    const input: Record<string, unknown> = {
      ...item,
      ...(url ? { url } : {}),
      ...(pattern ? { prompt: `Find ${pattern} in page` } : {}),
    };
    delete input.query;
    return input;
  }
  const query = webSearchQuery(item);
  return query ? { ...item, query } : item;
}

function summarizeTool(item: Record<string, unknown>): string | undefined {
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
        if (pattern && url) return `${pattern} · ${url}`;
        return pattern ?? url ?? webSearchQuery(item);
      }
      if (actionType === "other") return url ?? webSearchQuery(item);
      return webSearchQuery(item);
    }
    case "fileChange":
    case "file_change": {
      if (!Array.isArray(item.changes)) return undefined;
      const paths = item.changes.flatMap((change) => {
        const path = normalizeSummary(record(change)?.path);
        return path ? [path] : [];
      });
      if (paths.length === 1) return paths[0];
      return paths.length > 1 ? `${paths.length} files` : undefined;
    }
    default:
      return undefined;
  }
}

function firstHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const start = value.search(/https?:\/\//u);
  if (start < 0) return undefined;
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
  return value.slice(start, end).replace(/[.,;:]$/u, "") || undefined;
}

function rawResponseOutputText(item: Record<string, unknown>): string | undefined {
  if (typeof item.output === "string") return text(item.output);
  if (!Array.isArray(item.output)) return undefined;
  const parts = item.output.flatMap((part) => {
    const value = text(record(part)?.text);
    return value ? [value] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function rawWebOutputUrl(item: Record<string, unknown>): string | undefined {
  const output = rawResponseOutputText(item);
  if (!output) return undefined;
  for (const line of output.split("\n")) {
    const headerStart = line.search(/\(\s*https?:\/\//u);
    if (headerStart < 0 || !line.trimEnd().endsWith(")")) continue;
    const url = firstHttpUrl(line.slice(headerStart + 1));
    if (url) return url;
  }
  return undefined;
}

function singleRawWebCall(item: Record<string, unknown>): {
  callId: string;
  inputUrl?: string;
} | undefined {
  if (itemType(item) !== "custom_tool_call" || text(item.name) !== "exec") return undefined;
  const input = text(item.input);
  const callId = text(item.call_id) ?? text(item.callId);
  if (!input || !callId) return undefined;
  if (!/^\s*(?:(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)?await\s+tools\.web__run\s*\(/u
    .test(input)) {
    return undefined;
  }
  const matches = input.match(/tools\.web__run\s*\(/gu);
  if (matches?.length !== 1) return undefined;
  const inputUrl = firstHttpUrl(input);
  return { callId, ...(inputUrl ? { inputUrl } : {}) };
}

function withWebUrl(item: Record<string, unknown>, url: string | undefined): Record<string, unknown> {
  if (!url || webUrl(item)) return item;
  return { ...item, url };
}

function normalizePlanStatus(value: unknown): string | undefined {
  const status = text(value);
  if (!status) return undefined;
  return status.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/\s+/g, "_");
}

function planItems(value: unknown): ToolPlanItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: ToolPlanItem[] = [];
  for (const raw of value) {
    const step = record(raw);
    const itemText = normalizeSummary(step?.step ?? step?.text);
    const status = normalizePlanStatus(step?.status);
    if (!itemText || !status) return undefined;
    items.push({ text: itemText, status });
  }
  return items.length > 0 ? items : undefined;
}

function planToolInfo(params: Record<string, unknown>, turnId: string): ToolUseInfo | undefined {
  const items = planItems(params.plan);
  if (!items) return undefined;
  const completed = items.filter(({ status }) => status === "completed").length;
  return {
    callId: `${turnId}:plan`,
    name: "TodoWrite",
    summary: `${completed}/${items.length} steps completed`,
    planItems: items,
    input: params,
  };
}

function backgroundStatus(value: unknown): BackgroundAgentStatus | undefined {
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
      return undefined;
  }
}

function terminalBackgroundStatus(status: BackgroundAgentStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

function toUsage(
  params: Record<string, unknown>,
  threadId: string,
  turnId: string,
  model: string | undefined,
  fallbackWindow: number | undefined,
): TokenUsage | undefined {
  if (params.threadId !== threadId || params.turnId !== turnId) return undefined;
  const tokenUsage = record(params.tokenUsage);
  const last = record(tokenUsage?.last);
  if (!last) return undefined;
  const used = toTokenCount(last.totalTokens);
  if (used <= 0) return undefined;
  const input = toTokenCount(last.inputTokens);
  const cached = toTokenCount(last.cachedInputTokens);
  const contextWindow = toContextWindow(tokenUsage?.modelContextWindow) ?? fallbackWindow;
  return {
    contextTokens: used,
    inputTokens: Math.max(0, input - cached),
    cachedInputTokens: cached,
    outputTokens: toTokenCount(last.outputTokens),
    ...(model ? { model } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

function threadIdFrom(value: unknown): string | undefined {
  return text(record(record(value)?.thread)?.id);
}

function turnIdFrom(value: unknown): string | undefined {
  return text(record(record(value)?.turn)?.id);
}

function turnStatus(value: unknown): string | undefined {
  return text(record(record(value)?.turn)?.status);
}

interface OpenedCodexThread {
  threadId: string;
  model?: string;
}

function requestCodexThread(
  client: CodexAppServerClient,
  opts: Pick<
    RunCodexOptions,
    | "cwd"
    | "dangerouslyBypassApprovalsAndSandbox"
    | "developerInstructions"
    | "model"
    | "resumeSessionId"
  >,
): Promise<unknown> {
  return opts.resumeSessionId
    ? client.request("thread/resume", {
        threadId: opts.resumeSessionId,
        cwd: opts.cwd,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.developerInstructions
          ? { developerInstructions: opts.developerInstructions }
          : {}),
        ...(opts.dangerouslyBypassApprovalsAndSandbox
          ? { approvalPolicy: "never", sandbox: "danger-full-access" }
          : {}),
      })
    : client.request("thread/start", {
        cwd: opts.cwd,
        experimentalRawEvents: true,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.developerInstructions
          ? { developerInstructions: opts.developerInstructions }
          : {}),
        ...(opts.dangerouslyBypassApprovalsAndSandbox
          ? { approvalPolicy: "never", sandbox: "danger-full-access" }
          : {}),
      });
}

function openedCodexThread(value: unknown, fallbackModel?: string): OpenedCodexThread {
  const threadId = threadIdFrom(value);
  if (!threadId) throw new CodexTurnError("Codex app-server did not return a thread ID");
  const model = text(record(value)?.model) ?? fallbackModel;
  return { threadId, ...(model ? { model } : {}) };
}

/** Links turns that share one thread: a reused session can see late
 * notifications from any earlier turn before the next `turn/start` is acked,
 * and latching onto one would misattribute events across turns. */
interface TurnContinuity {
  previousTurnIds?: ReadonlySet<string>;
  onTurnId?: (turnId: string) => void;
}

interface PendingCodexWebTool {
  item: Record<string, unknown>;
  completed: boolean;
  rawCallId?: string;
}

interface RawCodexWebCall {
  callId: string;
  inputUrl?: string;
  outputUrl?: string;
  outputCompleted: boolean;
  webItemId?: string;
}

async function runCodexAppServerTurn(
  opts: RunCodexOptions,
  client: CodexAppServerClient,
  openedThread?: OpenedCodexThread,
  ownedClient = false,
  continuity?: TurnContinuity,
): Promise<RunResult> {
  if (opts.signal?.aborted) throw new AbortError("codex run aborted");

  const isPreviousTurn = (turnId: string): boolean =>
    continuity?.previousTurnIds?.has(turnId) ?? false;
  let threadId = openedThread?.threadId ?? opts.resumeSessionId;
  let turnId: string | undefined;
  let resolvedModel = opts.model ?? openedThread?.model;
  let finalText = "";
  let latestUsage: TokenUsage | undefined;
  let settled = false;
  let interruption: AbortError | TimeoutError | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const emittedTools = new Set<string>();
  const backgroundAgents = new Map<string, BackgroundAgentInfo>();
  const pendingWebTools = new Map<string, PendingCodexWebTool>();
  const rawWebCalls = new Map<string, RawCodexWebCall>();
  const unassignedRawWebCalls: string[] = [];

  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // Notification errors can arrive while a request response is still being
  // processed. Attach a handler immediately, then await the original promise
  // below so Node never treats that legitimate ordering as unhandled.
  void completion.catch(() => {});

  let rejectLifecycle!: (error: AbortError | TimeoutError) => void;
  let lifecycleFailed = false;
  const lifecycleFailure = new Promise<never>((_resolve, reject) => {
    rejectLifecycle = reject;
  });

  const failLifecycle = (error: AbortError | TimeoutError): void => {
    if (lifecycleFailed) return;
    lifecycleFailed = true;
    rejectLifecycle(error);
  };

  const raceLifecycle = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([operation, lifecycleFailure]);

  const settleError = (error: Error): void => {
    if (settled) return;
    settled = true;
    rejectCompletion(error);
  };

  const requestInterrupt = (): void => {
    if (!interruption || !threadId || !turnId) return;
    void client.request("turn/interrupt", { threadId, turnId })
      .catch(() => {})
      .finally(() => failLifecycle(interruption as AbortError | TimeoutError));
  };

  const interrupt = (error: AbortError | TimeoutError): void => {
    if (interruption || settled) return;
    interruption = error;
    // Without a turn ID there is nothing to interrupt gracefully — fail the
    // lifecycle right away; the turn/start error path retires the process,
    // which terminates any turn the server may have started meanwhile.
    if (threadId && turnId) requestInterrupt();
    else failLifecycle(error);
  };

  const abortHandler = (): void => interrupt(new AbortError("codex run aborted"));
  if (opts.signal) {
    if (opts.signal.aborted) abortHandler();
    else opts.signal.addEventListener("abort", abortHandler, { once: true });
  }
  let runDeadline: number | undefined;
  if (opts.timeoutMs !== undefined) {
    runDeadline = Date.now() + opts.timeoutMs;
    timeout = setTimeout(
      () => interrupt(new TimeoutError(`codex run timed out after ${opts.timeoutMs}ms`)),
      opts.timeoutMs,
    );
  }

  const emitToolUse = (id: string, item: Record<string, unknown>): void => {
    if (emittedTools.has(id)) return;
    const name = toolName(item);
    if (!name) return;
    emittedTools.add(id);
    const summary = summarizeTool(item);
    safeCallback(() => opts.onToolUse?.({
      callId: id,
      name,
      ...(summary ? { summary } : {}),
      input: toolInput(item),
    }));
  };

  const emitToolResult = (id: string, item: Record<string, unknown>): void => {
    const exitCode = item.exitCode;
    const status = text(item.status);
    safeCallback(() => opts.onToolResult?.({
      callId: id,
      content: item,
      ...((typeof exitCode === "number" && exitCode !== 0) || status === "failed"
        ? { isError: true }
        : {}),
    }));
  };

  const assignRawWebCall = (id: string, pending: PendingCodexWebTool): void => {
    if (pending.rawCallId) return;
    for (let index = unassignedRawWebCalls.length - 1; index >= 0; index -= 1) {
      const call = rawWebCalls.get(unassignedRawWebCalls[index] as string);
      if (!call || call.webItemId) unassignedRawWebCalls.splice(index, 1);
    }
    if (unassignedRawWebCalls.length !== 1) return;
    const callId = unassignedRawWebCalls.shift();
    if (!callId) return;
    const call = rawWebCalls.get(callId);
    if (!call) return;
    call.webItemId = id;
    pending.rawCallId = callId;
  };

  const emitPendingWebTool = (id: string, force: boolean): void => {
    const pending = pendingWebTools.get(id);
    if (!pending) return;
    const rawCall = pending.rawCallId ? rawWebCalls.get(pending.rawCallId) : undefined;
    const item = withWebUrl(pending.item, rawCall?.inputUrl ?? rawCall?.outputUrl);
    const needsUrl = toolName(item) === "WebFetch" && !webUrl(item);
    if (!force && needsUrl && rawCall && !rawCall.outputCompleted) return;
    emitToolUse(id, item);
    if (pending.completed) emitToolResult(id, item);
    if (pending.completed || force) pendingWebTools.delete(id);
  };

  const flushPendingWebTools = (): void => {
    for (const id of [...pendingWebTools.keys()]) emitPendingWebTool(id, true);
  };

  const handleRawResponseItem = (params: Record<string, unknown>): void => {
    const item = record(params.item);
    if (!item) return;
    const rawCall = singleRawWebCall(item);
    if (rawCall) {
      rawWebCalls.set(rawCall.callId, {
        ...rawCall,
        outputCompleted: false,
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

  const updateBackgroundAgents = (item: Record<string, unknown>, occurredAt: number): void => {
    const type = itemType(item);
    if (type !== "collabAgentToolCall" && type !== "collab_tool_call") return;
    const tool = text(item.tool);
    const isSpawn = tool === "spawnAgent" || tool === "spawn_agent";
    const states = record(property(item, "agentsStates", "agents_states")) ?? {};
    const rawReceiverIds = property(item, "receiverThreadIds", "receiver_thread_ids");
    const receiverIds = Array.isArray(rawReceiverIds)
      ? rawReceiverIds.filter((id): id is string => typeof id === "string")
      : [];
    for (const id of new Set([...receiverIds, ...Object.keys(states)])) {
      const current = backgroundAgents.get(id);
      if (!current && !isSpawn) continue;
      const state = record(states[id]);
      const status = backgroundStatus(state?.status) ?? current?.status ?? "pending";
      const message = text(state?.message);
      const itemId = text(item.id);
      const description = current?.description ?? text(item.prompt);
      const agent: BackgroundAgentInfo = {
        ...(current ?? {
          id,
          provider: "codex" as const,
          startedAt: occurredAt,
        }),
        ...(!current?.parentToolCallId && itemId ? { parentToolCallId: itemId } : {}),
        ...(description ? { description } : {}),
        status,
        ...(message && status === "failed" ? { error: message } : {}),
        ...(message && status !== "failed" ? { summary: message } : {}),
        updatedAt: occurredAt,
        ...(terminalBackgroundStatus(status)
          ? { endedAt: current?.endedAt ?? occurredAt }
          : {}),
      };
      if (status === "failed") delete agent.summary;
      else delete agent.error;
      backgroundAgents.set(id, agent);
      safeCallback(() => opts.onBackgroundAgentUpdate?.(agent));
    }
  };

  const handleItem = (method: string, params: Record<string, unknown>): void => {
    if (params.threadId !== threadId) return;
    const eventTurnId = text(params.turnId);
    if (!eventTurnId || isPreviousTurn(eventTurnId)) return;
    turnId ??= eventTurnId;
    if (turnId !== eventTurnId) return;
    const item = record(params.item);
    if (!item) return;
    const occurredAt = typeof params.startedAtMs === "number"
      ? params.startedAtMs
      : typeof params.completedAtMs === "number" ? params.completedAtMs : Date.now();
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
      const id = text(item.id) ?? `${itemType(item)}:web`;
      const pending = pendingWebTools.get(id) ?? {
        item,
        completed: false,
      };
      pending.item = item;
      pending.completed = method === "item/completed";
      assignRawWebCall(id, pending);
      pendingWebTools.set(id, pending);
      if (pending.completed) emitPendingWebTool(id, false);
      return;
    }

    const name = toolName(item);
    if (!name) return;
    const id = text(item.id) ?? `${itemType(item)}:${name}`;
    emitToolUse(id, item);
    if (method === "item/completed") emitToolResult(id, item);
  };

  const removeUserInputRequest = opts.onUserInputRequest
    ? client.onServerRequest("item/tool/requestUserInput", async ({ params: rawParams }) => {
        const rawRecord = record(rawParams);
        if (!rawRecord || rawRecord.threadId !== threadId) return undefined;
        const normalized = codexUserInputRequest(rawParams);
        if (isPreviousTurn(normalized.turnId)) return undefined;
        if (turnId && normalized.turnId !== turnId) return undefined;
        turnId ??= normalized.turnId;
        const response = await raceLifecycle(opts.onUserInputRequest!(normalized.request));
        const questionIds = new Set(normalized.request.questions.map(({ id }) => id));
        const answers: Record<string, { answers: string[] }> = {};
        for (const [questionId, values] of Object.entries(response.answers)) {
          if (!questionIds.has(questionId) || !Array.isArray(values)) continue;
          Object.defineProperty(answers, questionId, {
            value: {
              answers: values.filter((value): value is string => typeof value === "string"),
            },
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        return { answers };
      })
    : () => {};

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
    if (method === "item/agentMessage/delta") {
      // A pooled connection multiplexes threads, and an interrupted turn can
      // trail deltas after the next one starts — both must be filtered out.
      if (params.threadId !== threadId) return;
      const eventTurnId = text(params.turnId);
      if (!eventTurnId || isPreviousTurn(eventTurnId) || (turnId && eventTurnId !== turnId)) {
        return;
      }
      turnId ??= eventTurnId;
      // Raw, not the trimming text() helper: word boundaries arrive as
      // leading spaces and paragraph breaks as whitespace-only chunks, so
      // trimming here jams the streamed words together.
      const chunk = typeof params.delta === "string" ? params.delta : "";
      if (chunk) safeCallback(() => opts.onAssistantTextDelta?.(chunk));
      return;
    }
    if (method === "rawResponseItem/completed") {
      if (params.threadId !== threadId) return;
      const eventTurnId = text(params.turnId);
      if (!eventTurnId || isPreviousTurn(eventTurnId) || (turnId && eventTurnId !== turnId)) {
        return;
      }
      turnId ??= eventTurnId;
      handleRawResponseItem(params);
      return;
    }
    if (method === "turn/plan/updated" && params.threadId === threadId) {
      const eventTurnId = text(params.turnId);
      if (!eventTurnId || isPreviousTurn(eventTurnId) || (turnId && eventTurnId !== turnId)) {
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
      flushPendingWebTools();
      const message = text(record(params.error)?.message) ?? "Codex turn failed";
      settleError(new CodexTurnError(`Codex error: ${message}`));
      return;
    }
    if (method !== "turn/completed" || params.threadId !== threadId) return;
    const completedTurnId = text(record(params.turn)?.id);
    if (!completedTurnId || isPreviousTurn(completedTurnId)
      || (turnId && completedTurnId !== turnId)) {
      return;
    }
    turnId ??= completedTurnId;
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
    const message = text(record(record(params.turn)?.error)?.message)
      ?? `Codex turn ${status ?? "failed"}`;
    settleError(new CodexTurnError(message));
  });
  const removeClose = client.onClose((error) => settleError(error));
  const removeStderr = client.onStderr((chunk) => safeCallback(() => opts.onStderr?.(chunk)));

  try {
    if (!openedThread) {
      const opened = openedCodexThread(
        await raceLifecycle(requestCodexThread(client, opts)),
        resolvedModel,
      );
      threadId = opened.threadId;
      resolvedModel = opened.model;
    }
    safeCallback(() => opts.onSessionId?.(threadId as string));
    const input: Array<Record<string, unknown>> = [
      { type: "text", text: opts.prompt, text_elements: [] },
      ...(opts.imagePaths ?? []).map((path) => ({ type: "localImage", path })),
    ];
    // Cap the ack wait at the caller's remaining run budget so a silent
    // server cannot outlive a shorter opts.timeoutMs.
    const turnStartTimeoutMs = runDeadline === undefined
      ? TURN_START_TIMEOUT_MS
      : Math.max(1, Math.min(TURN_START_TIMEOUT_MS, runDeadline - Date.now()));
    let turnResult: unknown;
    try {
      turnResult = await raceLifecycle(client.request("turn/start", {
        threadId,
        input,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
        ...(opts.serviceTier !== undefined ? { serviceTier: opts.serviceTier } : {}),
        ...(opts.sandboxPolicy ? { sandboxPolicy: opts.sandboxPolicy } : {}),
      }, turnStartTimeoutMs));
    } catch (error) {
      // The turn may have started server-side despite the lost ack, and an
      // unacked start cannot be trusted to unwind before the session is
      // reused: best-effort interrupt when the turn is identifiable, then
      // retire the whole app-server process either way. A pooled session
      // recreates and resumes the thread on its next turn.
      if ((error instanceof TimeoutError || error instanceof AbortError) && threadId) {
        if (turnId && !interruption) {
          void client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
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
      sessionId: threadId as string,
      ...(latestUsage ? { usage: latestUsage } : {}),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    flushPendingWebTools();
    opts.signal?.removeEventListener("abort", abortHandler);
    removeNotification();
    removeUserInputRequest();
    removeClose();
    removeStderr();
    const finishedTurnId = turnId;
    if (finishedTurnId) safeCallback(() => continuity?.onTurnId?.(finishedTurnId));
    if (ownedClient) client.close();
  }
}

export async function createCodexAppServerSession(
  options: CreateCodexAppServerSessionOptions,
): Promise<CodexAppServerSession> {
  const client = await createCodexAppServerClient({
    cwd: options.cwd,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
  });

  let opened: OpenedCodexThread;
  try {
    opened = openedCodexThread(await requestCodexThread(client, options), options.model);
  } catch (error) {
    client.close();
    throw error;
  }

  let closed = false;
  let running = false;
  const previousTurnIds = new Set<string>();
  let closePromise: Promise<void> | undefined;
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
          ...(options.executablePath ? { executablePath: options.executablePath } : {}),
          ...(options.env ? { env: options.env } : {}),
          ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
          ...(options.dangerouslyBypassApprovalsAndSandbox !== undefined
            ? {
                dangerouslyBypassApprovalsAndSandbox:
                  options.dangerouslyBypassApprovalsAndSandbox,
              }
            : {}),
          ...(options.developerInstructions
            ? { developerInstructions: options.developerInstructions }
            : {}),
        }, client, opened, false, {
          previousTurnIds,
          onTurnId: (turnId) => {
            previousTurnIds.add(turnId);
          },
        });
      } finally {
        running = false;
      }
    },
    onClose(handler) {
      return client.onClose(handler);
    },
    close(): Promise<void> {
      closePromise ??= clientExitPromises.get(client) ?? Promise.resolve();
      if (!closed) closed = true;
      client.close();
      return closePromise;
    },
  };
}

export async function runCodexAppServer(opts: RunCodexOptions): Promise<RunResult> {
  if (opts.signal?.aborted) throw new AbortError("codex run aborted");
  const ownedClient = !opts.appServerClient;
  const client = opts.appServerClient ?? await createCodexAppServerClient({
    cwd: opts.cwd,
    ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
  });
  return runCodexAppServerTurn(opts, client, undefined, ownedClient);
}
