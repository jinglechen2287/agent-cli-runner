import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyAgyOutcome, loadNodeSqliteStepReader, type AgyLastStep } from "../src/agy-outcome.js";
import { AgyTurnError, ProviderTurnError } from "../src/errors.js";

const NOW = new Date("2026-11-20T12:00:00.000Z");
const errorStep = (text: string, reachedModel = false): AgyLastStep => ({
  type: 17,
  payload: new TextEncoder().encode(text),
  reachedModel,
});

describe("classifyAgyOutcome", () => {
  it("passes a clean end_turn", () => {
    expect(classifyAgyOutcome("end_turn", undefined, NOW)).toBeUndefined();
    expect(classifyAgyOutcome("end_turn", { type: 15, payload: null, reachedModel: true }, NOW)).toBeUndefined();
  });

  it("reads a rate limit with its reset delay", () => {
    const error = classifyAgyOutcome(
      "end_turn",
      errorStep("RESOURCE_EXHAUSTED (code 429): Resource has been exhausted. retryDelay:30s ]"),
      NOW,
    );
    expect(error).toBeInstanceOf(AgyTurnError);
    expect(error).toBeInstanceOf(ProviderTurnError);
    expect(error).toMatchObject({
      provider: "agy", kind: "usage_limit", retryable: true, code: "RESOURCE_EXHAUSTED",
      resetAt: "2026-11-20T12:00:30.000Z",
    });
  });

  it("reads a quota that names its reset time", () => {
    const error = classifyAgyOutcome(
      "end_turn",
      errorStep("Error 429, Message: quota, Status: RESOURCE_EXHAUSTED reason:QUOTA_EXHAUSTED quotaResetTimeStamp:2026-11-21T00:00:00Z ]"),
      NOW,
    );
    expect(error).toMatchObject({ kind: "usage_limit", retryable: true, resetAt: "2026-11-21T00:00:00Z" });
  });

  it("treats a refusal stop reason as a usage limit even without a step", () => {
    expect(classifyAgyOutcome("refusal", undefined, NOW)).toMatchObject({
      kind: "usage_limit", retryable: true, code: "QUOTA_EXHAUSTED", stopReason: "refusal",
    });
  });

  it("marks an invalid thinking signature as broken", () => {
    const error = classifyAgyOutcome(
      "end_turn",
      errorStep("messages.3.content.0: Invalid `signature` in `thinking` block"),
      NOW,
    );
    expect(error).toMatchObject({ kind: "provider_error", broken: true, retryable: true });
  });

  it("makes a 404 after the model answered retryable, and one before it not", () => {
    const text = "NOT_FOUND (code 404): Requested entity was not found.";
    expect(classifyAgyOutcome("end_turn", errorStep(text, true), NOW)).toMatchObject({
      kind: "provider_error", retryable: true, code: "NOT_FOUND", broken: false,
    });
    expect(classifyAgyOutcome("end_turn", errorStep(text, false), NOW)).toMatchObject({
      kind: "provider_error", retryable: false,
    });
  });

  it("fails any other error step", () => {
    expect(classifyAgyOutcome("end_turn", errorStep("panic: something odd"), NOW)).toMatchObject({
      kind: "provider_error", retryable: false,
    });
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loadNodeSqliteStepReader", async () => {
  const reader = await loadNodeSqliteStepReader();
  const sqlite = await import("node:sqlite").catch(() => undefined);
  it.skipIf(!reader || !sqlite)("reads the newest step after an index, and whether the model answered", () => {
    const root = mkdtempSync(join(tmpdir(), "agy-steps-"));
    roots.push(root);
    const file = join(root, "s.db");
    const database = new sqlite!.DatabaseSync(file);
    database.exec("CREATE TABLE steps (idx INTEGER, step_type INTEGER, step_payload BLOB)");
    const insert = database.prepare("INSERT INTO steps VALUES (?, ?, ?)");
    insert.run(0, 14, new Uint8Array([1]));
    insert.run(1, 15, new Uint8Array([2]));
    insert.run(2, 17, new TextEncoder().encode("boom"));
    database.close();

    expect(reader!.lastIndex(file)).toBe(2);
    const step = reader!.lastStepAfter(file, 0);
    expect(step?.type).toBe(17);
    expect(step?.reachedModel).toBe(true);
    expect(new TextDecoder().decode(step!.payload!)).toBe("boom");
    expect(reader!.lastStepAfter(file, 2)).toBeUndefined();
    expect(reader!.lastIndex(join(root, "missing.db"))).toBeUndefined();
  });
});
