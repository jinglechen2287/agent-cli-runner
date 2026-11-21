import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agyDataRoot, isAgyId, literalPath } from "../src/agy-paths.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agyDataRoot", () => {
  it("prefers geminiDir, then GEMINI_HOME, then HOME/.gemini", () => {
    expect(agyDataRoot({ geminiDir: "/g", env: { GEMINI_HOME: "/h", HOME: "/home/u" } })).toBe(join("/g", "antigravity-cli"));
    expect(agyDataRoot({ env: { GEMINI_HOME: "/h", HOME: "/home/u" } })).toBe(join("/h", "antigravity-cli"));
    expect(agyDataRoot({ env: { HOME: "/home/u" } })).toBe(join("/home/u", ".gemini", "antigravity-cli"));
    expect(agyDataRoot({ env: { USERPROFILE: "C:/Users/u" } })).toBe(join("C:/Users/u", ".gemini", "antigravity-cli"));
  });

  it("joins appDataDir beneath the gemini dir", () => {
    expect(agyDataRoot({ geminiDir: "/g", appDataDir: "antigravity-acp", env: {} })).toBe(join("/g", "antigravity-acp"));
  });
});

describe("isAgyId", () => {
  it("accepts uuids and refuses anything that could leave a directory", () => {
    expect(isAgyId("9fa4d9a3-4137-4cbe-a8c6-5818dbac6560")).toBe(true);
    expect(isAgyId("call_12156881786425950430")).toBe(true);
    for (const bad of ["", "..", "../x", "a/b", "a\\b", "a.b"]) expect(isAgyId(bad)).toBe(false);
  });
});

describe("literalPath", () => {
  it("returns an existing path whose segments are not links", async () => {
    const root = mkdtempSync(join(tmpdir(), "agy-paths-"));
    roots.push(root);
    mkdirSync(join(root, "brain", "s1"), { recursive: true });
    writeFileSync(join(root, "brain", "s1", "f.json"), "{}");
    await expect(literalPath(root, ["brain", "s1", "f.json"])).resolves.toBe(join(root, "brain", "s1", "f.json"));
    await expect(literalPath(root, ["brain", "missing"])).resolves.toBeUndefined();
  });

  it("refuses a link anywhere below the root, and segments that climb out", async () => {
    const root = mkdtempSync(join(tmpdir(), "agy-paths-"));
    const outside = mkdtempSync(join(tmpdir(), "agy-outside-"));
    roots.push(root, outside);
    mkdirSync(join(root, "brain"));
    symlinkSync(outside, join(root, "brain", "s1"), "junction");
    await expect(literalPath(root, ["brain", "s1"])).resolves.toBeUndefined();
    await expect(literalPath(root, ["..", "x"])).resolves.toBeUndefined();
    await expect(literalPath(root, ["brain/s1"])).resolves.toBeUndefined();
  });
});
