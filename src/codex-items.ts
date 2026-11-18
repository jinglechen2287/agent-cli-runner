/**
 * Reading Codex's wire items: tool names, inputs and summaries shared by the
 * app-server and `codex exec` paths, web-call URLs, plans, background agents,
 * token usage, MCP status, and elicitation requests.
 */
import {
  isRecord,
  isTerminalAgentStatus,
  normalizeSummary,
  planCompletionSummary,
  planItem,
  toContextWindow,
  toPlanItems,
  toTokenCount,
} from "./internal.js";
import type {
  BackgroundAgentInfo,
  BackgroundAgentStatus,
  McpElicitationRequest,
  McpServerStatusInfo,
  ToolPlanItem,
  ToolUseInfo,
} from "./types.js";
import { tokenUsage, type TokenUsage } from "./usage.js";

export function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function property(item: Record<string, unknown>, camel: string, snake: string): unknown {
  return item[camel] ?? item[snake];
}

export function itemType(item: Record<string, unknown>): string | undefined {
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

export function isWebItem(item: Record<string, unknown>): boolean {
  const type = itemType(item);
  return type === "webSearch" || type === "web_search";
}

export function webUrl(item: Record<string, unknown>): string | undefined {
  return text(webAction(item)?.url) ?? text(item.url);
}

/** Shared by the app-server and `codex exec` paths (both item spellings are
 * handled) so the two runners can never drift on tool naming. */
export function toolName(item: Record<string, unknown>): string | null {
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
      // The form Claude reports, so a host reads one name for an MCP tool.
      return tool && server ? `mcp__${server}__${tool}` : tool ?? "MCP";
    }
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

export function toolInput(item: Record<string, unknown>): Record<string, unknown> {
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

export function summarizeTool(item: Record<string, unknown>): string | undefined {
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

export function rawWebOutputUrl(item: Record<string, unknown>): string | undefined {
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

export function singleRawWebCall(item: Record<string, unknown>): {
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

function planItems(value: unknown): ToolPlanItem[] | undefined {
  return toPlanItems(value, (step) => planItem(step.step ?? step.text, step.status));
}

export function planToolInfo(params: Record<string, unknown>, turnId: string): ToolUseInfo | undefined {
  const items = planItems(params.plan);
  if (!items) return undefined;
  return {
    callId: `${turnId}:plan`,
    name: "TodoWrite",
    summary: planCompletionSummary(items),
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

export function toUsage(
  params: Record<string, unknown>,
  threadId: string,
  turnId: string,
  model: string | undefined,
  fallbackWindow: number | undefined,
): TokenUsage | undefined {
  if (params.threadId !== threadId || params.turnId !== turnId) return undefined;
  const reported = record(params.tokenUsage);
  const last = record(reported?.last);
  if (!last) return undefined;
  if (toTokenCount(last.totalTokens) <= 0) return undefined;
  const input = toTokenCount(last.inputTokens);
  return codexTokenUsage({
    // Input side only (cached included), per the TokenUsage contract — not
    // last.totalTokens, which also counts output. Matches the Claude and
    // isolated-exec paths. A compaction sends no request: Codex reports its
    // estimate of the compacted history as a total with no input behind it.
    contextTokens: input > 0 ? input : toTokenCount(last.totalTokens),
    input,
    cached: toTokenCount(last.cachedInputTokens),
    output: toTokenCount(last.outputTokens),
  }, model, toContextWindow(reported?.modelContextWindow) ?? fallbackWindow);
}

/** A TokenUsage from Codex's counts, whose input includes its cached part.
 * The caller says what fills the context: app-server's input (or, after a
 * compaction, its total) and exec's input. */
export function codexTokenUsage(
  counts: { contextTokens: number; input: number; cached: number; output: number },
  model: string | undefined,
  contextWindow: number | undefined,
): TokenUsage {
  return tokenUsage({
    contextTokens: counts.contextTokens,
    inputTokens: Math.max(0, counts.input - counts.cached),
    cachedInputTokens: counts.cached,
    outputTokens: counts.output,
  }, model, contextWindow);
}

export function threadIdFrom(value: unknown): string | undefined {
  return text(record(record(value)?.thread)?.id);
}

export function turnIdFrom(value: unknown): string | undefined {
  return text(record(record(value)?.turn)?.id);
}

export function turnStatus(value: unknown): string | undefined {
  return text(record(record(value)?.turn)?.status);
}

export function codexMcpStatus(params: Record<string, unknown>): McpServerStatusInfo | undefined {
  const name = text(params.name);
  if (!name) return undefined;
  const error = text(params.error);
  const failed = (status: McpServerStatusInfo["status"]): McpServerStatusInfo => ({
    name,
    status,
    ...(error ? { error } : {}),
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
      return undefined;
  }
}

/** The request a host can answer, or undefined for a mode only Codex's own
 * clients understand. */
export function codexElicitationRequest(params: Record<string, unknown>): McpElicitationRequest | undefined {
  const serverName = text(params.serverName);
  const message = typeof params.message === "string" ? params.message : undefined;
  if (!serverName || message === undefined) return undefined;
  if (params.mode === "form") {
    const requestedSchema = record(params.requestedSchema);
    return requestedSchema ? { serverName, message, mode: "form", requestedSchema } : undefined;
  }
  if (params.mode === "url") {
    const url = text(params.url);
    return url ? { serverName, message, mode: "url", url } : undefined;
  }
  return undefined;
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

export interface WebToolTracker {
  /** A webSearch item started or completed. */
  onWebItem(item: Record<string, unknown>, completed: boolean): void;
  /** A raw response item, which may be the `web__run` call behind one. */
  onRawResponseItem(item: Record<string, unknown>): void;
  /** Hand over every web item still held, with what is known of it. */
  flush(): void;
}

/** Holds each webSearch item until the single raw `web__run` call behind it,
 * when there is one, has supplied the page URL the item itself leaves out. */
export function createWebToolTracker(emit: {
  toolUse(id: string, item: Record<string, unknown>): void;
  toolResult(id: string, item: Record<string, unknown>): void;
}): WebToolTracker {
  const pendingWebTools = new Map<string, PendingCodexWebTool>();
  const rawWebCalls = new Map<string, RawCodexWebCall>();
  const unassignedRawWebCalls: string[] = [];

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
    emit.toolUse(id, item);
    if (pending.completed) emit.toolResult(id, item);
    if (pending.completed || force) pendingWebTools.delete(id);
  };

  return {
    onWebItem(item, completed) {
      const id = text(item.id) ?? `${itemType(item)}:web`;
      const pending = pendingWebTools.get(id) ?? {
        item,
        completed: false,
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
    },
    flush() {
      for (const id of [...pendingWebTools.keys()]) emitPendingWebTool(id, true);
    },
  };
}

/** Tracks the subagents a turn's collab tool calls start, and reports each
 * change as a complete snapshot. */
export function createCodexAgentTracker(onUpdate: (agent: BackgroundAgentInfo) => void): {
  update(item: Record<string, unknown>, occurredAt: number): void;
} {
  const backgroundAgents = new Map<string, BackgroundAgentInfo>();
  return {
    update(item, occurredAt) {
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
          ...(isTerminalAgentStatus(status)
            ? { endedAt: current?.endedAt ?? occurredAt }
            : {}),
        };
        if (status === "failed") delete agent.summary;
        else delete agent.error;
        backgroundAgents.set(id, agent);
        onUpdate(agent);
      }
    },
  };
}
