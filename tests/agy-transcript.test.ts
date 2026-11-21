import { readFileSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgySession, type ToolResultInfo, type ToolUseInfo } from "../src/index.js";
import { captureRequests, makeFakeChild } from "./helpers/fake-child.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "agy");

/** A fake `agy acp` that replays a recorded transcript: for each request the
 * session sends, it writes the recorded lines up to that request's answer. */
function replay(file: string) {
  const lines = readFileSync(join(FIXTURES, file), "utf8").split("\n").filter(Boolean);
  const child = makeFakeChild();
  child.kill = (() => {
    queueMicrotask(() => child.emit("close", null));
    return true;
  }) as never;
  let next = 0;
  captureRequests(child, (message) => {
    if (message.id === undefined || message.method === undefined) return;
    while (next < lines.length) {
      const line = lines[next++]!;
      child.stdout.write(`${line}\n`);
      const recorded = JSON.parse(line) as { id?: unknown; method?: unknown };
      if (recorded.method === undefined && recorded.id === message.id) break;
    }
  });
  return child;
}

describe("a recorded agy 1.5.13 turn", () => {
  it("replays a file read into the shared tool, text and usage shapes", async () => {
    const child = replay("read-file.jsonl");
    const session = await createAgySession({
      cwd: "/tmp/project",
      mode: "accept-edits",
      spawnFn: (() => child) as never,
      stepReader: null,
      env: { HOME: "/nonexistent" },
    });
    const uses: ToolUseInfo[] = [];
    const results: ToolResultInfo[] = [];
    const result = await session.runTurn({
      prompt: "Read notes.txt with your file tool, then reply with its contents in one line.",
      onToolUse: (use) => uses.push(use),
      onToolResult: (toolResult) => results.push(toolResult),
    });
    expect(uses).toEqual([{
      callId: "call_12993297239072111632",
      name: "Read",
      summary: "/tmp/project/notes.txt",
      input: { Path: "/tmp/project/notes.txt" },
    }]);
    expect(results.map((toolResult) => [toolResult.callId, toolResult.isError])).toEqual([["call_12993297239072111632", undefined]]);
    expect(result).toEqual({
      text: "rivers and mountains",
      exitCode: 0,
      sessionId: "11111111-2222-4333-8444-555555555555",
      usage: {
        contextTokens: 10919, inputTokens: 12335, cachedInputTokens: 7779, outputTokens: 1011,
        model: "gemini-3.8-flash", contextWindow: 1_048_576,
      },
    });
    await session.close();
  });
});

describe("recorded fixtures", () => {
  it("carry no local paths, user names, emails or credentials", () => {
    const user = userInfo().username;
    for (const file of readdirSync(FIXTURES)) {
      const text = readFileSync(join(FIXTURES, file), "utf8");
      // The user name only as a path segment: as a word it can be ordinary text.
      const userSegment = new RegExp(`[\\\\/]${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\\\/]|$)`);
      for (const pattern of [/\/Users\//, /\/home\//, /\/var\/folders\//, /[\w.+-]+@[\w-]+\.[\w.]+/, /"(access|refresh)_?token"/i, /ya29\./, userSegment]) {
        expect(pattern.test(text), `${file} matches ${pattern}`).toBe(false);
      }
    }
  });
});
