/**
 * Pure translators from agy's ACP `session/update` payloads to this library's
 * provider-normalized shapes: tool uses and results, plan snapshots, usage,
 * and permission options. Field spellings and the subagent and held-tool
 * rules follow T3 Code's agy adapter.
 */
import {
  isRecord,
  normalizeSummary,
  planCompletionSummary,
  planItem,
  toPlanItems,
  toTokenCount,
} from "./internal.js";
import type { ToolResultInfo, ToolUseInfo } from "./types.js";
import { tokenUsage, type TokenUsage } from "./usage.js";

/** A tool call as the updates so far describe it: `tool_call` and every
 * `tool_call_update` merged, later fields winning. */
export interface AgyToolCall {
  toolCallId: string;
  name?: string;
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  args?: Record<string, unknown>;
  rawOutput?: unknown;
  content?: unknown;
  locations?: Array<Record<string, unknown>>;
  meta?: Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Merge one `tool_call` / `tool_call_update` into the call's state. Answers
 * undefined for an update without a tool call id. */
export function mergeAgyToolCall(
  previous: AgyToolCall | undefined,
  update: Record<string, unknown>,
): AgyToolCall | undefined {
  const toolCallId = text(update.toolCallId) ?? previous?.toolCallId;
  if (!toolCallId) return undefined;
  const next: AgyToolCall = { ...previous, toolCallId };
  const name = text(update.name);
  if (name) next.name = name;
  const kind = text(update.kind);
  if (kind) next.kind = kind;
  const title = text(update.title);
  if (title) next.title = title;
  const status = text(update.status);
  if (status) next.status = status;
  if (isRecord(update.rawInput)) next.rawInput = update.rawInput;
  if (isRecord(update.args)) next.args = update.args;
  // ACP's null leaves a field as it was, like an omitted one.
  if (update.rawOutput !== undefined && update.rawOutput !== null) next.rawOutput = update.rawOutput;
  if (update.content !== undefined && update.content !== null) next.content = update.content;
  if (Array.isArray(update.locations)) next.locations = update.locations.filter(isRecord);
  if (isRecord(update._meta)) next.meta = update._meta;
  return next;
}

function input(call: AgyToolCall): Record<string, unknown> | undefined {
  return call.rawInput ?? call.args;
}

function field(call: AgyToolCall, names: readonly string[]): unknown {
  const values = input(call);
  if (!values) return undefined;
  for (const name of names) {
    if (values[name] !== undefined) return values[name];
  }
  return undefined;
}

const COMMAND_FIELDS = ["CommandLine", "command_line", "commandLine", "command"] as const;

// T3 AntigravityProtocol.ts: agy reports subagent launches as ordinary tools,
// told apart only by their titles.
const SUBAGENT_TITLES = new Set([
  "Running start_subagent",
  "Run start_subagent?",
  "Running invoke_subagent",
  "Run invoke_subagent?",
  "Run invoke_subagent",
]);
const SCHEDULE_TITLES = new Set(["Run schedule", "Running schedule"]);

/** A tool call that starts an agy subagent. MCP calls that happen to share a
 * title are not. */
export function isAgySubagentCall(call: AgyToolCall): boolean {
  if (call.kind !== undefined && call.kind !== "other") return false;
  if (call.title === undefined || !SUBAGENT_TITLES.has(call.title)) return false;
  return call.meta?.is_mcp_tool_call !== true;
}

/** A tool the agent keeps running after its prompt ends, replying by itself
 * when it finishes: a command that is not a daemon, or a scheduled wake. */
/** A command agy started to keep running, such as a dev server: no turn waits for it. */
export function isAgyDaemon(call: AgyToolCall): boolean {
  return call.kind === "execute" && input(call)?.IsDaemon === true;
}

export function toolOutlivesPrompt(call: AgyToolCall): boolean {
  if (call.title !== undefined && SCHEDULE_TITLES.has(call.title)) return true;
  return call.kind === "execute" && input(call)?.IsDaemon !== true;
}

const TOOL_NAMES: Readonly<Record<string, string>> = {
  run_command: "Bash",
  view_file: "Read",
  read_file: "Read",
  write_to_file: "Write",
  write_file: "Write",
  replace_file_content: "Edit",
  multi_replace_file_content: "Edit",
  edit_file: "Edit",
  sed_file: "Edit",
  notebook_edit: "NotebookEdit",
  grep_search: "Grep",
  find_by_name: "Glob",
  list_dir: "LS",
  search_web: "WebSearch",
  read_url_content: "WebFetch",
};

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "NotebookEdit"]);

/** The provider-normalized name of an agy tool; unknown tools keep agy's. */
export function agyToolName(call: AgyToolCall): string {
  if (isAgySubagentCall(call)) return "Agent";
  const name = call.name ?? "";
  if (Object.hasOwn(TOOL_NAMES, name)) return TOOL_NAMES[name]!;
  return name || "Tool";
}

function titleSummary(call: AgyToolCall): string | undefined {
  const title = normalizeSummary(call.title);
  if (!title || /^Run(?:ning)? [\w-]+\??$/.test(title)) return undefined;
  return title;
}

function summarize(call: AgyToolCall, name: string): string | undefined {
  if (name === "Bash") return normalizeSummary(field(call, COMMAND_FIELDS)) ?? titleSummary(call);
  if (FILE_TOOLS.has(name)) {
    return normalizeSummary(call.locations?.[0]?.path) ?? titleSummary(call);
  }
  if (name === "Agent") return normalizeSummary(field(call, ["Role"])) ?? titleSummary(call);
  return titleSummary(call);
}

/** The tool use one agy tool call reports. */
export function agyToolUse(call: AgyToolCall): ToolUseInfo {
  const name = agyToolName(call);
  const summary = summarize(call, name);
  const values = input(call);
  return {
    callId: call.toolCallId,
    name,
    ...(summary ? { summary } : {}),
    ...(values ? { input: values } : {}),
  };
}

function exitCode(output: unknown): number | undefined {
  if (!isRecord(output)) return undefined;
  for (const key of ["exit_code", "exitCode"]) {
    const value = output[key];
    if (typeof value === "number") return value;
  }
  return undefined;
}

/** Whether agy has finished with this tool call, however it ended. */
export function isTerminalToolStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed";
}

/** The result of a finished tool call, or undefined while it runs. */
export function agyToolResult(call: AgyToolCall): ToolResultInfo | undefined {
  if (!isTerminalToolStatus(call.status)) return undefined;
  const code = exitCode(call.rawOutput);
  const isError = call.status === "failed" || (code !== undefined && code !== 0);
  return {
    callId: call.toolCallId,
    content: call.rawOutput ?? call.content,
    ...(isError ? { isError: true } : {}),
    ...(call.rawOutput !== undefined ? { structured: call.rawOutput } : {}),
  };
}

/** An ACP `plan` update as a TodoWrite snapshot, or undefined for an empty or
 * malformed plan. */
export function agyPlanToolUse(sessionId: string, update: Record<string, unknown>): ToolUseInfo | undefined {
  const planItems = toPlanItems(update.entries, (entry) => planItem(entry.content, entry.status));
  if (!planItems) return undefined;
  return {
    callId: `${sessionId}:plan`,
    name: "TodoWrite",
    summary: planCompletionSummary(planItems),
    planItems,
    input: { entries: update.entries },
  };
}

/** A `usage_update` as a context-usage snapshot: occupancy and window only,
 * since agy reports no per-request split. */
export function agyUsage(update: Record<string, unknown>, model: string | undefined): TokenUsage {
  const size = typeof update.size === "number" && update.size > 0 ? Math.round(update.size) : undefined;
  return tokenUsage(
    { contextTokens: toTokenCount(update.used), inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    model,
    size,
  );
}

/** The turn's last snapshot, with the counts the prompt response reported:
 * input excludes cached reads, output includes thought tokens. */
export function agyFinalUsage(
  last: TokenUsage | undefined,
  response: unknown,
  model: string | undefined,
): TokenUsage | undefined {
  if (!isRecord(response)) return last;
  return tokenUsage(
    {
      contextTokens: last?.contextTokens ?? 0,
      inputTokens: toTokenCount(response.inputTokens),
      cachedInputTokens: toTokenCount(response.cachedReadTokens),
      outputTokens: toTokenCount(response.outputTokens),
    },
    last?.model ?? model,
    last?.contextWindow,
  );
}

export interface AgyPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

/** The id of the option of `kind`, falling back from an "always" kind to its
 * "once" kind, or undefined when neither is offered. */
export function pickPermissionOption(
  options: readonly AgyPermissionOption[],
  kind: string,
): string | undefined {
  const find = (wanted: string) => options.find((option) => option.kind === wanted)?.optionId;
  const fallback = kind === "allow_always" ? "allow_once" : kind === "reject_always" ? "reject_once" : undefined;
  return find(kind) ?? (fallback ? find(fallback) : undefined);
}

/** The options of a permission request, as far as they are well formed. */
export function permissionOptions(value: unknown): AgyPermissionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    if (!isRecord(option) || typeof option.optionId !== "string") return [];
    return [{
      optionId: option.optionId,
      ...(typeof option.name === "string" ? { name: option.name } : {}),
      ...(typeof option.kind === "string" ? { kind: option.kind } : {}),
    }];
  });
}
