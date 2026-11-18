import { describe, expect, it, vi } from "vitest";
import { TimeoutError } from "../src/errors.js";
import {
  createDeferred,
  isTerminalAgentStatus,
  planItem,
  raceTimeout,
  toPlanItems,
  withoutUndefined,
} from "../src/internal.js";
import type { BackgroundAgentStatus } from "../src/types.js";

describe("withoutUndefined", () => {
  it("drops undefined values and keeps every other falsy one", () => {
    const copy = withoutUndefined({ a: undefined, b: null, c: "", d: 0, e: false, f: "x" });
    expect(copy).toStrictEqual({ b: null, c: "", d: 0, e: false, f: "x" });
  });
});

describe("createDeferred", () => {
  it("is settled the moment it resolves", async () => {
    const deferred = createDeferred<number>();
    expect(deferred.settled).toBe(false);
    deferred.resolve(1);
    expect(deferred.settled).toBe(true);
    await expect(deferred.promise).resolves.toBe(1);
  });

  it("is settled the moment it rejects", async () => {
    const deferred = createDeferred();
    const failure = new Error("stopped");
    deferred.reject(failure);
    expect(deferred.settled).toBe(true);
    await expect(deferred.promise).rejects.toBe(failure);
  });
});

describe("raceTimeout", () => {
  it("settles with the first contender and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      await expect(raceTimeout([Promise.resolve(1)], 100, () => new TimeoutError())).resolves.toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with the timeout's error once the time is up", async () => {
    vi.useFakeTimers();
    try {
      const failure = new TimeoutError("waited too long");
      const outcome = raceTimeout([new Promise<never>(() => {})], 100, () => failure)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      await expect(outcome).resolves.toBe(failure);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("toPlanItems", () => {
  const toItem = (entry: Record<string, unknown>) => planItem(entry.text, entry.status);

  it("normalizes every entry", () => {
    expect(toPlanItems([
      { text: "  Wire the   endpoint ", status: "inProgress" },
      { text: "Ship it", status: "completed" },
    ], toItem)).toEqual([
      { text: "Wire the endpoint", status: "in_progress" },
      { text: "Ship it", status: "completed" },
    ]);
  });

  it("gives no plan for a malformed entry, an empty list, or no list", () => {
    expect(toPlanItems([{ text: "a", status: "pending" }, "junk"], toItem)).toBeUndefined();
    expect(toPlanItems([{ text: "a" }], toItem)).toBeUndefined();
    expect(toPlanItems([], toItem)).toBeUndefined();
    expect(toPlanItems("a plan", toItem)).toBeUndefined();
  });
});

describe("isTerminalAgentStatus", () => {
  it("treats completed, failed and interrupted agents as finished", () => {
    const statuses: BackgroundAgentStatus[] = ["pending", "running", "completed", "failed", "interrupted"];
    expect(statuses.filter(isTerminalAgentStatus)).toEqual(["completed", "failed", "interrupted"]);
  });
});
