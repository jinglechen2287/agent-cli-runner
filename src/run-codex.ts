import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { CodexTurnError, MissingCliError } from "./errors.js";
import {
  createLineSplitter,
  filterEnv,
  isMissingExecutable,
  normalizeSummary,
  signalProcessTree,
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
  SpawnFn,
  ToolPlanItem,
} from "./types.js";
import type { TokenUsage } from "./usage.js";

/** Stripped so a Codex turn spawned from within another Codex session does
 * not inherit the parent's thread. */
export const CODEX_STRIPPED_ENV_VARS = ["CODEX_THREAD_ID"] as const;

export interface RunCodexOptions extends CommonRunOptions {
  /** Pass `--dangerously-bypass-approvals-and-sandbox` so Codex runs with
   * full host access and no approval prompts. Off by default — only enable
   * this for trusted prompts in environments you accept it can modify. */
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  /** Text passed via `-c developer_instructions=...` on every turn. */
  developerInstructions?: string;
  /** Resume an existing thread by id (turn 2+). */
  resumeSessionId?: string;
  /** Image paths passed via repeated `-i` flags. */
  imagePaths?: string[];
  /** Model to run, passed via `--model`. Used as usage attribution only when
   * the app-server snapshot does not report the resolved model. */
  model?: string;
  /** Explicit context-window fallback (tokens). Codex app-server's reported
   * `modelContextWindow` is authoritative whenever it is available. */
  contextWindow?: number;
  /** Run a non-persistent one-shot request in a read-only sandbox without
   * user config or exec-policy rules. Intended for small metadata tasks. */
  isolated?: boolean;
}

interface CodexStreamEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: unknown;
  item?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

interface AppServerMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

const APP_SERVER_INITIALIZE_ID = 1;
const APP_SERVER_RESUME_ID = 2;
const APP_SERVER_USAGE_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function codexBackgroundAgentStatus(status: unknown): BackgroundAgentStatus | undefined {
  switch (status) {
    case "pending_init":
      return "pending";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "errored":
    case "not_found":
      return "failed";
    case "interrupted":
    case "shutdown":
      return "interrupted";
    default:
      return undefined;
  }
}

function isTerminalBackgroundAgentStatus(status: BackgroundAgentStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

/** Convert app-server's authoritative last-request snapshot into the shared
 * context-occupancy shape. `last.totalTokens` is the current used context;
 * `last.inputTokens` already includes cached input, and `last.outputTokens`
 * already includes its reasoning-token subset. */
function toCodexUsage(
  params: unknown,
  threadId: string,
  model: string | undefined,
  explicitContextWindow: number | undefined,
): TokenUsage | undefined {
  if (!isRecord(params) || params.threadId !== threadId || !isRecord(params.tokenUsage)) {
    return undefined;
  }
  const tokenUsage = params.tokenUsage;
  if (!isRecord(tokenUsage.last)) return undefined;
  const last = tokenUsage.last;
  const used = toTokenCount(last.totalTokens);
  if (used <= 0) return undefined;
  const input = toTokenCount(last.inputTokens);
  const cached = toTokenCount(last.cachedInputTokens);
  const contextWindow =
    toContextWindow(tokenUsage.modelContextWindow) ?? explicitContextWindow;
  return {
    contextTokens: used,
    inputTokens: Math.max(0, input - cached),
    cachedInputTokens: cached,
    outputTokens: toTokenCount(last.outputTokens),
    ...(model ? { model } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

/** Query the completed exec thread through app-server. Unlike `exec --json`,
 * app-server exposes both cumulative totals and the last request; resuming a
 * persisted thread immediately replays its latest authoritative snapshot. */
function queryCodexUsage(
  opts: RunCodexOptions,
  threadId: string,
  spawnFn: SpawnFn,
): Promise<TokenUsage | undefined> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(opts.executablePath ?? "codex", ["app-server", "--stdio"], {
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: filterEnv(opts.env ?? process.env, CODEX_STRIPPED_ENV_VARS),
        detached: process.platform !== "win32",
      });
    } catch {
      resolve(undefined);
      return;
    }

    let settled = false;
    let resumed = false;
    let resolvedModel = opts.model;
    let pendingParams: unknown;
    const timer = setTimeout(() => finish(), APP_SERVER_USAGE_TIMEOUT_MS);

    const send = (message: Record<string, unknown>): void => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    };

    const finish = (usage?: TokenUsage): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signalProcessTree(child, "SIGTERM");
      resolve(usage);
    };

    const maybeFinish = (): void => {
      if (!resumed || pendingParams === undefined) return;
      const usage = toCodexUsage(
        pendingParams,
        threadId,
        resolvedModel,
        opts.contextWindow,
      );
      if (usage) finish(usage);
    };

    const handleLine = (line: string): void => {
      let message: AppServerMessage;
      try {
        message = JSON.parse(line) as AppServerMessage;
      } catch {
        return;
      }
      if (message.id === APP_SERVER_INITIALIZE_ID) {
        if (message.error !== undefined) {
          finish();
          return;
        }
        send({ method: "initialized" });
        send({
          id: APP_SERVER_RESUME_ID,
          method: "thread/resume",
          params: { threadId },
        });
        return;
      }
      if (message.id === APP_SERVER_RESUME_ID) {
        if (message.error !== undefined) {
          finish();
          return;
        }
        if (isRecord(message.result) && typeof message.result.model === "string") {
          resolvedModel = message.result.model;
        }
        resumed = true;
        maybeFinish();
        return;
      }
      if (message.method === "thread/tokenUsage/updated") {
        pendingParams = message.params;
        maybeFinish();
      }
    };

    const splitter = createLineSplitter(handleLine);
    child.stdout?.on("data", (chunk: Buffer | string) => splitter.push(chunk));
    child.stderr?.resume();
    child.stdin?.on("error", () => finish());
    child.on("error", () => finish());
    child.on("close", () => {
      splitter.flush();
      finish();
    });

    send({
      id: APP_SERVER_INITIALIZE_ID,
      method: "initialize",
      params: {
        clientInfo: {
          name: "agent-cli-runner",
          title: "Agent CLI Runner",
          version: "0.1.0",
        },
        capabilities: null,
      },
    });
  });
}

function toolName(item: Record<string, unknown>): string | null {
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

/** Normalize both the current `todo_list.items` shape and the older
 * `plan_update.plan` shape. A malformed entry invalidates the whole snapshot
 * so consumers never present a misleading partial plan. */
function codexPlanItems(item: Record<string, unknown>): ToolPlanItem[] | undefined {
  const rawItems = Array.isArray(item.items)
    ? item.items
    : Array.isArray(item.plan) ? item.plan : undefined;
  if (!rawItems) return undefined;

  const items: ToolPlanItem[] = [];
  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      return undefined;
    }
    const record = rawItem as Record<string, unknown>;
    const text = normalizeSummary(record.text) ?? normalizeSummary(record.step);
    if (!text) return undefined;
    let status: string | undefined;
    if (typeof record.completed === "boolean") {
      status = record.completed ? "completed" : "pending";
    } else {
      status = normalizeSummary(record.status)?.toLowerCase().replace(/\s+/g, "_");
    }
    if (!status) return undefined;
    items.push({ text, status });
  }
  return items.length > 0 ? items : undefined;
}

/** Codex nests a web_search's query under `action.query` (with `action.queries`
 * for multi-query searches); older/flat items put it directly on `query`.
 * Resolve whichever is present so the query survives into the transcript. */
function codexWebSearchQuery(item: Record<string, unknown>): string | undefined {
  const direct = normalizeSummary(item.query);
  if (direct) return direct;
  const action = item.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) return undefined;
  const record = action as Record<string, unknown>;
  const query = normalizeSummary(record.query);
  if (query) return query;
  if (Array.isArray(record.queries)) {
    for (const candidate of record.queries) {
      const normalized = normalizeSummary(candidate);
      if (normalized) return normalized;
    }
  }
  return undefined;
}

/** The raw stream item to retain as the tool's `input`. web_search hides its
 * query under `action`, so lift it to the top level where `toolCallDetails`
 * (which reads `input.query`) can find it. */
function codexToolInput(item: Record<string, unknown>): Record<string, unknown> {
  if (item.type !== "web_search") return item;
  return { ...item, query: codexWebSearchQuery(item) };
}

/** Pull a one-line target or plan completion count out of a Codex stream item.
 * Returns undefined when the item carries nothing meaningful to summarize. */
function summarizeCodexTool(
  item: Record<string, unknown>,
  planItems?: ToolPlanItem[],
): string | undefined {
  switch (item.type) {
    case "command_execution":
      return normalizeSummary(item.command);
    case "web_search":
      return codexWebSearchQuery(item);
    case "file_change": {
      if (!Array.isArray(item.changes)) return undefined;
      const paths = item.changes
        .map((change) =>
          change && typeof change === "object"
            ? normalizeSummary((change as Record<string, unknown>).path)
            : undefined,
        )
        .filter((path): path is string => path !== undefined);
      if (paths.length === 1) return paths[0];
      if (paths.length > 1) return `${paths.length} files`;
      return undefined;
    }
    case "todo_list":
    case "plan_update": {
      if (!planItems || planItems.length === 0) return undefined;
      const completed = planItems.filter((planItem) => planItem.status === "completed").length;
      return `${completed}/${planItems.length} steps completed`;
    }
    default:
      return undefined;
  }
}

function fatalEventError(event: CodexStreamEvent): CodexTurnError | null {
  if (event.type !== "error" && event.type !== "turn.failed") return null;
  let detail: string | undefined;
  if (typeof event.message === "string") {
    detail = event.message;
  } else if (typeof event.error === "string") {
    detail = event.error;
  } else if (event.error && typeof event.error === "object") {
    const message = (event.error as Record<string, unknown>).message;
    if (typeof message === "string") detail = message;
  }
  const label = event.type === "turn.failed" ? "Codex turn failed" : "Codex error";
  return new CodexTurnError(detail ? `${label}: ${detail}` : label);
}

function buildArgs(opts: RunCodexOptions): string[] {
  const args = opts.resumeSessionId
    ? ["exec", "resume", "--json"]
    : ["exec", "--json"];
  if (opts.dangerouslyBypassApprovalsAndSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  args.push("--skip-git-repo-check");
  if (opts.isolated) {
    args.push(
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
    );
  }
  if (opts.model !== undefined) {
    args.push("--model", opts.model);
  }
  if (opts.developerInstructions !== undefined) {
    args.push("-c", `developer_instructions=${JSON.stringify(opts.developerInstructions)}`);
  }
  for (const imagePath of opts.imagePaths ?? []) {
    args.push("-i", imagePath);
  }
  if (opts.resumeSessionId) args.push(opts.resumeSessionId);
  // "-" makes `codex exec` read the prompt from stdin.
  args.push("-");
  return args;
}

/** Spawn a non-interactive Codex CLI turn (`codex exec --json`) and translate
 * its JSONL stream into the same callbacks used by the Claude runner. */
export async function runCodex(opts: RunCodexOptions): Promise<RunResult> {
  if (opts.isolated && opts.resumeSessionId) {
    throw new Error("isolated Codex runs cannot resume a session");
  }
  if (opts.isolated && opts.dangerouslyBypassApprovalsAndSandbox) {
    throw new Error("isolated Codex runs cannot bypass approvals and sandboxing");
  }
  const spawnFn = opts.spawnFn ?? nodeSpawn;
  const child = spawnFn(opts.executablePath ?? "codex", buildArgs(opts), {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: filterEnv(opts.env ?? process.env, CODEX_STRIPPED_ENV_VARS),
    detached: process.platform !== "win32",
  });
  writePrompt(child, opts.prompt);

  return new Promise<RunResult>((resolve, reject) => {
    let settled = false;
    let sessionId: string | undefined;
    let finalText: string | undefined;
    let fatalError: CodexTurnError | undefined;
    let lastUsage: TokenUsage | undefined;
    const emittedTools = new Set<string>();
    const backgroundAgents = new Map<string, BackgroundAgentInfo>();
    let hasCumulativeUsage = false;

    const lifecycle = watchLifecycle({
      cli: "codex",
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      kill: (signal) => signalProcessTree(child, signal),
    });

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: CodexStreamEvent;
      try {
        event = JSON.parse(trimmed) as CodexStreamEvent;
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
        // This block is cumulative across every model request in the turn. It
        // only tells us an authoritative snapshot is available to query; it is
        // never emitted as context occupancy.
        hasCumulativeUsage = true;
        return;
      }
      if (event.type !== "item.started" && event.type !== "item.completed") {
        if (event.type !== "item.updated") return;
      }
      const item = event.item;
      if (!item) return;
      if (item.type === "collab_tool_call") {
        const tool = item.tool;
        const isSpawn = tool === "spawn_agent" || tool === "spawnAgent";
        const states = isRecord(item.agents_states) ? item.agents_states : {};
        const receiverIds = Array.isArray(item.receiver_thread_ids)
          ? item.receiver_thread_ids.filter((id): id is string => typeof id === "string")
          : [];
        for (const id of new Set([...receiverIds, ...Object.keys(states)])) {
          const current = backgroundAgents.get(id);
          if (!current && !isSpawn) continue;
          const state = isRecord(states[id]) ? states[id] : undefined;
          const status = codexBackgroundAgentStatus(state?.status)
            ?? current?.status
            ?? "pending";
          const message = typeof state?.message === "string" ? state.message : undefined;
          const now = Date.now();
          const agent: BackgroundAgentInfo = {
            ...(current ?? {
              id,
              provider: "codex" as const,
              startedAt: now,
            }),
            ...(current?.parentToolCallId
              ? {}
              : typeof item.id === "string" ? { parentToolCallId: item.id } : {}),
            ...(typeof item.prompt === "string" ? { description: item.prompt } : {}),
            status,
            ...(message && status === "failed" ? { error: message } : {}),
            ...(message && status !== "failed" ? { summary: message } : {}),
            updatedAt: now,
            ...(isTerminalBackgroundAgentStatus(status)
              ? { endedAt: current?.endedAt ?? now }
              : {}),
          };
          if (status === "failed") {
            delete agent.summary;
          } else {
            delete agent.error;
          }
          backgroundAgents.set(id, agent);
          try {
            opts.onBackgroundAgentUpdate?.(agent);
          } catch {
            // A host callback must not interrupt the provider stream.
          }
        }
        return;
      }
      if (
        event.type === "item.completed" &&
        item.type === "agent_message" &&
        typeof item.text === "string"
      ) {
        finalText = item.text;
        opts.onAssistantText?.(item.text);
        return;
      }
      const name = toolName(item);
      if (!name) return;
      const id = typeof item.id === "string" ? item.id : `${item.type}:${name}`;
      if (emittedTools.has(id)) return;
      emittedTools.add(id);
      const planItems = codexPlanItems(item);
      const summary = summarizeCodexTool(item, planItems);
      opts.onToolUse?.({
        ...(typeof item.id === "string" ? { callId: item.id } : {}),
        name,
        ...(summary !== undefined ? { summary } : {}),
        ...(planItems !== undefined ? { planItems } : {}),
        input: codexToolInput(item),
      });
    };

    const splitter = createLineSplitter(handleLine);
    child.stdout?.on("data", (chunk: Buffer | string) => splitter.push(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      opts.onStderr?.(chunk.toString());
    });

    child.on("error", (error: Error) => {
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
      const exitCode = code ?? -1;
      const complete = async (): Promise<void> => {
        if (exitCode === 0 && sessionId && hasCumulativeUsage && !opts.isolated) {
          lastUsage = await queryCodexUsage(opts, sessionId, spawnFn);
          if (lastUsage) {
            try {
              opts.onUsage?.(lastUsage);
            } catch {
              // A host callback must not leave the run promise unsettled.
            }
          }
        }
        resolve({
          text: (finalText ?? "").trim(),
          exitCode,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(lastUsage !== undefined ? { usage: lastUsage } : {}),
        });
      };
      void complete();
    });
  });
}
