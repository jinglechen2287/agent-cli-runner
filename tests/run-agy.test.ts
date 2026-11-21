import type { SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MissingCliError, runAgy } from "../src/index.js";
import { answer, fakeAgy, SESSION } from "./helpers/fake-agy.js";

describe("runAgy", () => {
  it("opens a session, runs one turn and closes", async () => {
    const agy = fakeAgy({ onPrompt: answer("done", 42) });
    const ids: string[] = [];
    const result = await runAgy({
      prompt: "do it",
      cwd: "/tmp/project",
      spawnFn: agy.spawnFn,
      stepReader: null,
      onSessionId: (id) => ids.push(id),
    });
    expect(result).toMatchObject({ text: "done", exitCode: 0, sessionId: SESSION, usage: { contextTokens: 42, contextWindow: 1_048_576 } });
    expect(ids).toEqual([SESSION]);
    expect(agy.requests.map((message) => message.method).filter(Boolean)).toEqual([
      "initialize", "authenticate", "session/new", "session/prompt", "session/close",
    ]);
    expect(agy.child.kill).toHaveBeenCalled();
  });

  it("rejects with MissingCliError when agy is not installed", async () => {
    const enoent = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
    const error = await runAgy({
      prompt: "x",
      cwd: "/tmp/project",
      spawnFn: (() => { throw enoent; }) as never,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MissingCliError);
    expect((error as MissingCliError).cli).toBe("agy");
  });

  it("gives agy its own environment and data-dir flags", async () => {
    const agy = fakeAgy({ onPrompt: answer("ok") });
    let launched: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
    const result = await runAgy({
      prompt: "x",
      cwd: "/tmp/project",
      env: { PATH: "/usr/bin", ANTIGRAVITY_CONVERSATION_ID: "parent", HOME: "/home/u" },
      geminiDir: "/profiles/one",
      appDataDir: "antigravity-acp",
      stepReader: null,
      spawnFn: ((command: string, args: readonly string[], options: SpawnOptions) => {
        launched = { command, args, env: options.env ?? {} };
        return agy.child as never;
      }) as never,
    });
    expect(result.text).toBe("ok");
    expect(launched?.args).toEqual(["acp", "--gemini-dir", "/profiles/one", "--app-data-dir", "antigravity-acp"]);
    expect(launched?.env).not.toHaveProperty("ANTIGRAVITY_CONVERSATION_ID");
    expect(launched?.env).toMatchObject({
      PATH: "/usr/bin",
      AGY_CLI_DISABLE_AUTO_UPDATE: "1",
      GEMINI_HOME: "/profiles/one",
    });
    expect(String(launched?.env.BROWSER)).toContain("-e");
  });
});
