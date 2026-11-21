import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAgyChildren } from "../src/agy-children.js";
import { writeIdleNotice, writeLaunchMessage, writeReport, writeSubagent } from "./helpers/agy-brain.js";

const roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agy-brain-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readAgyChildren", () => {
  it("matches children to their launches and reads their reports", async () => {
    const root = makeRoot();
    writeSubagent(root, "parent-1", "fast-1", { role: "Fast Worker" });
    writeLaunchMessage(root, "parent-1", "fast-1", "call_fast");
    writeSubagent(root, "parent-1", "slow-1", { role: "Slow Worker" });
    writeLaunchMessage(root, "parent-1", "slow-1", "call_slow");
    writeReport(root, "parent-1", "fast-1", "m1", "first", "2026-11-20T22:04:22.957Z");
    writeReport(root, "parent-1", "fast-1", "m2", "fast-done", "2026-11-20T22:04:30.000Z");

    const children = await readAgyChildren(root, "parent-1", ["call_fast", "call_slow"]);
    expect(children.get("call_fast")).toEqual({
      childId: "fast-1", role: "Fast Worker", typeName: "self", state: "reported",
      summary: "fast-done", reportedAt: Date.parse("2026-11-20T22:04:30.000Z"),
    });
    expect(children.get("call_slow")).toEqual({ childId: "slow-1", role: "Slow Worker", typeName: "self", state: "running" });
  });

  it("reports a killed child", async () => {
    const root = makeRoot();
    writeSubagent(root, "parent-1", "c1", { state: "SUBAGENT_STATE_KILLED" });
    writeLaunchMessage(root, "parent-1", "c1", "call_1");
    expect((await readAgyChildren(root, "parent-1", ["call_1"])).get("call_1")?.state).toBe("killed");
  });

  it("ignores children launched by calls it was not asked about", async () => {
    const root = makeRoot();
    writeSubagent(root, "parent-1", "c1");
    writeLaunchMessage(root, "parent-1", "c1", "call_other");
    expect((await readAgyChildren(root, "parent-1", ["call_1"])).size).toBe(0);
  });

  it("reads nothing for an id that could leave the data root, or through a link", async () => {
    const root = makeRoot();
    expect((await readAgyChildren(root, "../parent", ["call_1"])).size).toBe(0);
    const outside = makeRoot();
    writeSubagent(outside, "parent-1", "c1");
    writeLaunchMessage(outside, "parent-1", "c1", "call_1");
    expect((await readAgyChildren(outside, "parent-1", ["call_1"])).size).toBe(1);
    // The same records, reached through a link to their brain folder.
    symlinkSync(join(outside, "brain"), join(root, "brain"), "junction");
    expect((await readAgyChildren(root, "parent-1", ["call_1"])).size).toBe(0);
  });

  it("finds a new report in an inbox past the file cap", async () => {
    const root = makeRoot();
    writeSubagent(root, "parent-1", "c1");
    writeLaunchMessage(root, "parent-1", "c1", "call_1");
    const inbox = join(root, "brain", "parent-1", ".system_generated", "messages");
    mkdirSync(inbox, { recursive: true });
    const old = new Date("2026-01-01T00:00:00Z");
    for (let index = 0; index < 300; index += 1) {
      const file = join(inbox, `a${String(index).padStart(3, "0")}.json`);
      writeFileSync(file, JSON.stringify({ sender: "someone-else", content: "noise" }));
      utimesSync(file, old, old);
    }
    writeReport(root, "parent-1", "c1", "zz-report", "done", "2026-11-20T22:00:00.000Z");
    expect((await readAgyChildren(root, "parent-1", ["call_1"])).get("call_1")).toMatchObject({ state: "reported", summary: "done" });
  });

  it("counts only the reports a child sent after the launch asked about", async () => {
    const root = makeRoot();
    writeSubagent(root, "parent-1", "c1");
    writeLaunchMessage(root, "parent-1", "c1", "call_1", "2026-11-20T22:00:00.000Z");
    writeReport(root, "parent-1", "c1", "m1", "first", "2026-11-20T22:01:00.000Z");
    writeLaunchMessage(root, "parent-1", "c1", "call_2", "2026-11-20T22:02:00.000Z");
    let children = await readAgyChildren(root, "parent-1", ["call_2"]);
    expect(children.get("call_2")).toMatchObject({ state: "running" });
    writeReport(root, "parent-1", "c1", "m2", "second", "2026-11-20T22:03:00.000Z");
    children = await readAgyChildren(root, "parent-1", ["call_1", "call_2"]);
    expect(children.get("call_2")).toMatchObject({ state: "reported", summary: "second" });
  });

  it("counts agy's notice that a child went idle as its report", async () => {
    const root = makeRoot();
    writeSubagent(root, "parent-1", "c1");
    writeLaunchMessage(root, "parent-1", "c1", "call_1", "2026-11-20T22:00:00.000Z");
    writeSubagent(root, "parent-1", "c2");
    writeLaunchMessage(root, "parent-1", "c2", "call_2", "2026-11-20T22:00:00.000Z");
    writeIdleNotice(root, "parent-1", "c1", "n1", "Ancient giants stand,\nCrowned in snow.", "2026-11-20T22:01:00.000Z");
    const children = await readAgyChildren(root, "parent-1", ["call_1", "call_2"]);
    expect(children.get("call_1")).toMatchObject({ state: "reported", summary: "Ancient giants stand,\nCrowned in snow." });
    expect(children.get("call_2")).toMatchObject({ state: "running" });

    // The child's own report wins over a later notice.
    writeReport(root, "parent-1", "c2", "m2", "the real report", "2026-11-20T22:02:00.000Z");
    writeIdleNotice(root, "parent-1", "c2", "n2", "Bye.", "2026-11-20T22:03:00.000Z");
    expect((await readAgyChildren(root, "parent-1", ["call_2"])).get("call_2")).toMatchObject({
      state: "reported", summary: "the real report",
    });
  });

  it("skips malformed and oversized records", async () => {
    const root = makeRoot();
    writeSubagent(root, "parent-1", "c1");
    writeLaunchMessage(root, "parent-1", "c1", "call_1");
    const dir = join(root, "brain", "parent-1", ".system_generated", "subagents");
    writeFileSync(join(dir, "broken.json"), "{not json");
    writeLaunchMessage(root, "parent-1", "big", "call_big");
    writeLaunchMessage(root, "parent-1", "huge", "call_huge");
    writeFileSync(join(dir, "big.json"), JSON.stringify({ conversationId: "big", pad: "x".repeat(900_000) }));
    writeFileSync(join(dir, "huge.json"), JSON.stringify({ conversationId: "huge", pad: "x".repeat(1_100_000) }));
    const children = await readAgyChildren(root, "parent-1", ["call_1", "call_big", "call_huge"]);
    expect([...children.keys()].sort()).toEqual(["call_1", "call_big"]);
  });
});
