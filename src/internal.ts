import type {
  AgentCallbacks,
  BackgroundAgentStatus,
  McpElicitationRequest,
  McpElicitationResponse,
  ToolPlanItem,
} from "./types.js";

/** Asks a turn's callback for an MCP server's answer. Always settles: no
 * callback declines, a throw or any of `signals` firing cancels, and a late
 * answer from the callback is ignored. */
export function answerMcpElicitation(
  callback: AgentCallbacks["onMcpElicitation"],
  request: McpElicitationRequest,
  signals: readonly AbortSignal[],
): Promise<McpElicitationResponse> {
  if (!callback) return Promise.resolve({ action: "decline" });
  const controller = new AbortController();
  const fire = (): void => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) return Promise.resolve({ action: "cancel" });
    signal.addEventListener("abort", fire, { once: true });
  }
  return new Promise<McpElicitationResponse>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve({ action: "cancel" }), { once: true });
    Promise.resolve()
      .then(() => callback(request, { signal: controller.signal }))
      .then(resolve, () => resolve({ action: "cancel" }));
  }).finally(() => {
    for (const signal of signals) signal.removeEventListener("abort", fire);
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The value when it is a string, else undefined. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Only string keys: Object.entries, which makes the copy, skips symbols. */
type WithoutUndefined<T> =
  { [K in Extract<keyof T, string> as undefined extends T[K] ? never : K]: T[K] }
  & { [K in Extract<keyof T, string> as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> };

/** A copy of `value`'s string-keyed entries without the undefined ones, so a
 * set of maybe-given options fits a type whose optional properties may not
 * hold undefined. */
export function withoutUndefined<T extends Record<string, unknown>>(value: T): WithoutUndefined<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as WithoutUndefined<T>;
}

/** A promise with its settle functions, and whether one has been called. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  /** True from the first resolve or reject call, synchronously. */
  readonly settled: boolean;
  resolve(value: T): void;
  reject(error: Error): void;
}

export function createDeferred<T = void>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
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
    },
  };
}

/** The first of `contenders` to settle, or `onTimeout()`'s error once `ms`
 * pass. One flat race, returned as it is, so awaiting it costs no more
 * microtask hops than awaiting `Promise.race` directly. The timer is cleared
 * as soon as the race settles, and holds the process open unless `unref`. */
export function raceTimeout<T>(
  contenders: readonly Promise<T>[],
  ms: number,
  onTimeout: () => Error,
  { unref = false }: { unref?: boolean } = {},
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    if (unref) timer.unref?.();
  });
  const race = Promise.race([...contenders, timeout]);
  const clear = (): void => clearTimeout(timer);
  race.then(clear, clear);
  return race;
}

/** Run a host callback without letting an exception escape into the provider
 * stream: a throwing callback must never crash the process, drop the rest of
 * a stdout chunk, or leave the run promise unsettled. An async callback's
 * rejection is swallowed too — an unhandled rejection would otherwise bring
 * down the process just like a synchronous throw. */
export function safeCallback(use: () => unknown): void {
  try {
    const result = use();
    if (
      result !== null
      && typeof result === "object"
      && typeof (result as PromiseLike<unknown>).then === "function"
    ) {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Host callbacks must never corrupt the provider stream.
  }
}

/** "N/M steps completed" — the one plan summary both providers report, kept
 * here so the cross-provider wording can never drift. */
export function planCompletionSummary(planItems: readonly { status: string }[]): string {
  const completed = planItems.filter((item) => item.status === "completed").length;
  return `${completed}/${planItems.length} steps completed`;
}

/** Normalize a provider plan/todo status into snake_case: camelCase
 * ("inProgress") and spaced ("in progress") forms both become "in_progress". */
export function normalizePlanStatus(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const status = value.trim();
  if (!status) return undefined;
  return status.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/\s+/g, "_");
}

/** One plan item from a provider's raw text and status, or undefined unless
 * both are present. */
export function planItem(text: unknown, status: unknown): ToolPlanItem | undefined {
  const itemText = normalizeSummary(text);
  const itemStatus = normalizePlanStatus(status);
  return itemText && itemStatus ? { text: itemText, status: itemStatus } : undefined;
}

/** A provider's plan/todo list as plan items, each made by `toItem` from the
 * provider's own fields. A malformed entry voids the whole list, so a host
 * never shows a misleading partial plan; an empty list is no plan either. */
export function toPlanItems(
  values: unknown,
  toItem: (entry: Record<string, unknown>) => ToolPlanItem | undefined,
): ToolPlanItem[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const items: ToolPlanItem[] = [];
  for (const value of values) {
    const item = isRecord(value) ? toItem(value) : undefined;
    if (!item) return undefined;
    items.push(item);
  }
  return items.length > 0 ? items : undefined;
}

/** Whether a background agent has finished, however it ended. */
export function isTerminalAgentStatus(status: BackgroundAgentStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

/** Collapse a raw tool field into the one-line, non-empty form promised by a
 * tool-use summary. Runs of whitespace (including newlines in a multiline
 * command) become single spaces; an empty or whitespace-only value yields
 * undefined so callers can omit the summary entirely. */
export function normalizeSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const summary = value.replace(/\s+/g, " ").trim();
  return summary || undefined;
}

/** Coerce a CLI-reported token count into a non-negative integer, defaulting
 * to 0 for missing, negative, or non-finite values. */
export function toTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

/** Coerce a CLI-reported context-window size into a positive integer, or
 * undefined when missing or malformed — callers fall back to the model-id
 * family rules instead of trusting a bogus wire value. */
export function toContextWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}
