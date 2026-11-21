/**
 * agy reports an upstream API failure (a quota, a rate limit, a broken
 * conversation) as a chat message and a plain `end_turn`. Its session log
 * ends that turn with an error step, so after each prompt the session reads
 * the steps the prompt added and classifies the last one. Ported from T3
 * Code's AntigravityTurnOutcome: the step types and the regexes are T3's.
 */
import { AgyTurnError } from "./errors.js";

/** CORTEX_STEP_TYPE_ERROR_MESSAGE in agy's trajectory. */
export const AGY_ERROR_STEP_TYPE = 17;
/** CORTEX_STEP_TYPE_PLANNER_RESPONSE: the model answered within this turn. */
export const AGY_PLANNER_RESPONSE_STEP_TYPE = 15;
/** The harness error text leads the payload; a Go stack trace follows it. */
const MAX_ERROR_PAYLOAD_BYTES = 16_384;

// The Go harness's rendering of a Google API error.
const API_ERROR = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/s;
// agy 1.5 with a Google account writes "STATUS (code NNN): message".
const STATUS_ERROR = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u;
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/;
// Claude rejects a saved thinking block without a valid signature. It sits in
// agy's history, so every later prompt to that session fails the same way.
const INVALID_THINKING_SIGNATURE =
  /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/;
const RESET_TIMESTAMP = /\bquotaResetTimeStamp:([^\s\]]+)/;
const RESET_DELAY = /\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
// google.rpc.RetryInfo, which plain rate limits carry instead of a quota reset.
const RETRY_DELAY = /\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const GO_DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/** The newest step a prompt added. */
export interface AgyLastStep {
  type: number;
  payload: Uint8Array | null;
  /** The model answered (a planner-response step) within the prompt. */
  reachedModel: boolean;
}

/** Reads agy's per-session step log, `conversations/<sid>.db`. */
export interface AgyStepReader {
  /** The newest step index, or undefined when the log can't be read. */
  lastIndex(dbPath: string): number | undefined;
  /** The newest step after `index`, or undefined when there is none. */
  lastStepAfter(dbPath: string, index: number): AgyLastStep | undefined;
}

function resetAtFrom(text: string, now: Date): string | undefined {
  const timestamp = RESET_TIMESTAMP.exec(text)?.[1];
  if (timestamp !== undefined && !Number.isNaN(Date.parse(timestamp))) return timestamp;
  const delay = RESET_DELAY.exec(text)?.[1] ?? RETRY_DELAY.exec(text)?.[1];
  if (delay === undefined) return undefined;
  let delayMs = 0;
  for (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) {
    delayMs += Number(amount) * (GO_DURATION_UNIT_MS[unit!] ?? 0);
  }
  return delayMs > 0 ? new Date(now.getTime() + delayMs).toISOString() : undefined;
}

/** STATUS_ERROR's groups reordered to API_ERROR's: HTTP status, message,
 * status name. */
function statusError(text: string): readonly [string, string, string, string] | null {
  const match = STATUS_ERROR.exec(text);
  return match === null ? null : [match[0], match[2]!, match[3]!, match[1]!];
}

/** The failure a prompt's stop reason and newest step describe, or undefined
 * for a turn that succeeded. */
export function classifyAgyOutcome(
  stopReason: string,
  step: AgyLastStep | undefined,
  now: Date,
): AgyTurnError | undefined {
  const errorText = step?.type === AGY_ERROR_STEP_TYPE
    ? new TextDecoder().decode(step.payload ?? new Uint8Array())
    : undefined;
  // The agent maps only the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
  if (errorText === undefined && stopReason !== "refusal") return undefined;
  const text = errorText ?? "";
  const apiError = API_ERROR.exec(text) ?? statusError(text);
  const base = { stopReason } as const;
  if (stopReason === "refusal" || QUOTA_EXHAUSTED.test(text)) {
    const resetAt = resetAtFrom(text, now);
    return new AgyTurnError("You have reached your Antigravity quota for this period.", {
      ...base,
      kind: "usage_limit",
      code: apiError?.[3] ?? "QUOTA_EXHAUSTED",
      retryable: true,
      ...(resetAt ? { resetAt } : {}),
    });
  }
  if (INVALID_THINKING_SIGNATURE.test(text)) {
    return new AgyTurnError(
      "Antigravity's saved conversation can no longer be sent to the model; start a fresh session.",
      { ...base, kind: "provider_error", code: "INVALID_THINKING_SIGNATURE", retryable: true, broken: true },
    );
  }
  if (apiError === null) {
    return new AgyTurnError("Antigravity stopped this turn because of an error.", {
      ...base,
      kind: "provider_error",
    });
  }
  const [, httpStatus, message, status] = apiError;
  const rateLimited = httpStatus === "429" || status === "RESOURCE_EXHAUSTED";
  // A 404 before the model answered is an unknown or unentitled model; after,
  // a transient edge error.
  const transientNotFound = httpStatus === "404" && step?.reachedModel === true;
  const resetAt = resetAtFrom(text, now);
  return new AgyTurnError(message!.trim(), {
    ...base,
    kind: rateLimited ? "usage_limit" : "provider_error",
    ...(status ? { code: status } : {}),
    retryable: rateLimited || transientNotFound || Number(httpStatus) >= 500,
    ...(resetAt ? { resetAt } : {}),
  });
}

interface SqliteStatement {
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => SqliteDatabase;
}

let sqliteModule: Promise<SqliteModule | undefined> | undefined;

/** `node:sqlite`, loaded once: available on Node 22.5+ and Bun. */
function loadSqlite(): Promise<SqliteModule | undefined> {
  sqliteModule ??= import("node:sqlite").then(
    (module) => module as unknown as SqliteModule,
    () => undefined,
  );
  return sqliteModule;
}

/** The default step reader, on `node:sqlite`, or undefined on a runtime
 * without it: outcomes then come from the stop reason alone. */
export async function loadNodeSqliteStepReader(): Promise<AgyStepReader | undefined> {
  const sqlite = await loadSqlite();
  if (!sqlite) return undefined;
  const withSteps = <A>(file: string, read: (database: SqliteDatabase) => A): A | undefined => {
    let database: SqliteDatabase;
    try {
      database = new sqlite.DatabaseSync(file, { readOnly: true });
    } catch {
      return undefined;
    }
    try {
      database.exec("PRAGMA busy_timeout = 100");
      const hasSteps = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
        .get() !== undefined;
      return hasSteps ? read(database) : undefined;
    } catch {
      return undefined;
    } finally {
      database.close();
    }
  };
  return {
    lastIndex(file) {
      return withSteps(file, (database) => {
        const index = database.prepare("SELECT max(idx) AS idx FROM steps").get()?.idx;
        return typeof index === "number" ? index : -1;
      });
    },
    lastStepAfter(file, index) {
      return withSteps(file, (database) => {
        const row = database
          .prepare(
            `SELECT step_type AS type, substr(step_payload, 1, ?) AS payload
             FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1`,
          )
          .get(MAX_ERROR_PAYLOAD_BYTES, index);
        if (typeof row?.type !== "number") return undefined;
        const reachedModel = database
          .prepare("SELECT 1 FROM steps WHERE idx > ? AND step_type = ? LIMIT 1")
          .get(index, AGY_PLANNER_RESPONSE_STEP_TYPE) !== undefined;
        return {
          type: row.type,
          payload: row.payload instanceof Uint8Array ? row.payload : null,
          reachedModel,
        };
      });
    },
  };
}
