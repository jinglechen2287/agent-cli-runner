import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runClaude } from "../src/index.js";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function readAll(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    stream.on("data", (chunk: Buffer | string) => {
      data += chunk.toString();
    });
    stream.on("end", () => resolve(data));
  });
}

function finish(child: FakeChild, code: number | null = 0): void {
  child.stdout.end();
  child.stderr.end();
  child.emit("close", code);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runClaude", () => {
  it("invokes claude with -p and stream-json output in the given cwd, passing the prompt via stdin", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const stdinData = readAll(child.stdin);

    const promise = runClaude({
      prompt: "make it round",
      cwd: "/tmp/proj",
      spawnFn: spawnFn as never,
    });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnFn.mock.calls[0]!;
    expect(cmd).toBe("claude");
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).not.toContain("make it round");
    expect(args).not.toContain("--append-system-prompt");
    expect(opts).toMatchObject({ cwd: "/tmp/proj" });

    finish(child);
    await expect(promise).resolves.toMatchObject({ exitCode: 0 });
    await expect(stdinData).resolves.toBe("make it round");
  });

  it("spawns a custom executable path when given", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      executablePath: "/opt/bin/claude-dev",
      spawnFn: spawnFn as never,
    });
    expect(spawnFn.mock.calls[0]![0]).toBe("/opt/bin/claude-dev");
    finish(child);
    await promise;
  });

  it("strips Claude nesting-guard variables from the spawn environment", async () => {
    vi.stubEnv("CLAUDECODE", "1");
    vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "cli");
    vi.stubEnv("CLAUDE_CODE_SESSION_ACCESS_TOKEN", "secret");
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({ prompt: "x", cwd: "/tmp", spawnFn: spawnFn as never });
    const env = spawnFn.mock.calls[0]![2].env as Record<string, string>;
    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(env).not.toHaveProperty("CLAUDE_CODE_SESSION_ACCESS_TOKEN");
    expect(env.PATH).toBe(process.env.PATH);
    finish(child);
    await promise;
  });

  it("applies stripping on top of a caller-provided base environment", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      env: { FOO: "bar", CLAUDECODE: "1" },
      spawnFn: spawnFn as never,
    });
    const env = spawnFn.mock.calls[0]![2].env as Record<string, string>;
    expect(env).toEqual({ FOO: "bar" });
    finish(child);
    await promise;
  });

  it("passes --append-system-prompt with the given text", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "make it round",
      cwd: "/tmp",
      appendSystemPrompt: "You are editing a running web app.",
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    const flagIndex = args.indexOf("--append-system-prompt");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe("You are editing a running web app.");
    finish(child);
    await promise;
  });

  it("passes --append-system-prompt alongside --resume on follow-up turns", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "follow up",
      cwd: "/tmp",
      resumeSessionId: "abc",
      appendSystemPrompt: "rules",
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    expect(args).toContain("--resume");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("rules");
    finish(child);
    await promise;
  });

  it("passes --session-id when newSessionId is provided", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      newSessionId: "11111111-1111-1111-1111-111111111111",
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    expect(args).toContain("--session-id");
    expect(args).toContain("11111111-1111-1111-1111-111111111111");
    finish(child);
    await promise;
  });

  it("passes --resume when resumeSessionId is provided", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "follow up",
      cwd: "/tmp",
      resumeSessionId: "abc",
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    expect(args).toContain("--resume");
    expect(args).toContain("abc");
    expect(args).not.toContain("--session-id");
    finish(child);
    await promise;
  });

  it("rejects instead of throwing when spawnFn throws synchronously", async () => {
    await expect(
      runClaude({
        prompt: "x",
        cwd: "/tmp",
        spawnFn: (() => {
          throw new Error("sync spawn failure");
        }) as never,
      }),
    ).rejects.toThrow(/sync spawn failure/);
  });

  it("reassembles multibyte characters split across stdout chunks", async () => {
    const child = makeFakeChild();
    const onAssistantText = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onAssistantText,
    });
    const line = Buffer.from(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "café ☕☕" }] },
      }) + "\n",
    );
    // Split inside the final ☕ (a 3-byte UTF-8 sequence).
    const splitAt = line.length - 4;
    child.stdout.write(line.subarray(0, splitAt));
    child.stdout.write(line.subarray(splitAt));
    finish(child);
    await promise;
    expect(onAssistantText).toHaveBeenCalledWith("café ☕☕");
  });

  it("rejects when both newSessionId and resumeSessionId are given", async () => {
    await expect(
      runClaude({
        prompt: "x",
        cwd: "/tmp",
        newSessionId: "a",
        resumeSessionId: "b",
        spawnFn: (() => makeFakeChild()) as never,
      }),
    ).rejects.toThrow(/mutually exclusive|both/i);
  });

  it("emits the session id from the system.init event and returns it in the result", async () => {
    const child = makeFakeChild();
    const onSessionId = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onSessionId,
    });
    child.stdout.write(
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }) + "\n",
    );
    finish(child);
    const result = await promise;
    expect(onSessionId).toHaveBeenCalledWith("sess-1");
    expect(onSessionId).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBe("sess-1");
  });

  it("emits assistant text via onAssistantText", async () => {
    const child = makeFakeChild();
    const onAssistantText = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onAssistantText,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello there" }] },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onAssistantText).toHaveBeenCalledWith("Hello there");
  });

  it("concatenates multiple text blocks in one assistant message", async () => {
    const child = makeFakeChild();
    const onAssistantText = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onAssistantText,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Part one. " },
            { type: "text", text: "Part two." },
          ],
        },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onAssistantText).toHaveBeenCalledWith("Part one. Part two.");
  });

  it("returns the result event's text and session id", async () => {
    const child = makeFakeChild();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Working on it" }] },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({ type: "result", result: "Final answer", session_id: "sess-9" }) +
        "\n",
    );
    finish(child);
    await expect(promise).resolves.toEqual({
      text: "Final answer",
      exitCode: 0,
      sessionId: "sess-9",
    });
  });

  it("falls back to the last assistant text when no result event arrives", async () => {
    const child = makeFakeChild();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });
    for (const text of ["First message", "Second message"]) {
      child.stdout.write(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text }] },
        }) + "\n",
      );
    }
    finish(child);
    const result = await promise;
    expect(result.text).toBe("Second message");
  });

  it("emits tool_use events via onToolUse", async () => {
    const child = makeFakeChild();
    const onToolUse = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onToolUse,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Edit",
              input: { file_path: "src/Button.tsx" },
            },
          ],
        },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onToolUse).toHaveBeenCalledWith({
      name: "Edit",
      summary: "src/Button.tsx",
      input: { file_path: "src/Button.tsx" },
    });
  });

  it("summarizes each known tool by its most identifying input field", async () => {
    const cases: Array<{
      name: string;
      input: Record<string, unknown>;
      summary: string | undefined;
    }> = [
      { name: "Read", input: { file_path: "a.ts" }, summary: "a.ts" },
      { name: "Bash", input: { command: "pnpm test" }, summary: "pnpm test" },
      { name: "Grep", input: { pattern: "TODO" }, summary: "TODO" },
      { name: "WebFetch", input: { url: "https://x.dev" }, summary: "https://x.dev" },
      { name: "WebSearch", input: { query: "vitest" }, summary: "vitest" },
      { name: "TodoWrite", input: { todos: [] }, summary: undefined },
      {
        name: "mcp__linear__create_issue",
        input: { title: "Bug" },
        summary: undefined,
      },
    ];

    for (const c of cases) {
      const child = makeFakeChild();
      const onToolUse = vi.fn();
      const promise = runClaude({
        prompt: "x",
        cwd: "/tmp",
        spawnFn: (() => child) as never,
        onToolUse,
      });
      child.stdout.write(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "t", name: c.name, input: c.input }],
          },
        }) + "\n",
      );
      finish(child);
      await promise;
      expect(onToolUse).toHaveBeenCalledWith({
        name: c.name,
        ...(c.summary !== undefined ? { summary: c.summary } : {}),
        input: c.input,
      });
    }
  });

  it("collapses a multiline command into a one-line summary", async () => {
    const child = makeFakeChild();
    const onToolUse = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onToolUse,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t",
              name: "Bash",
              input: { command: "pnpm build\n  && pnpm test" },
            },
          ],
        },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onToolUse).toHaveBeenCalledWith({
      name: "Bash",
      summary: "pnpm build && pnpm test",
      input: { command: "pnpm build\n  && pnpm test" },
    });
  });

  it("omits the summary when the input field is empty or whitespace", async () => {
    const child = makeFakeChild();
    const onToolUse = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onToolUse,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t", name: "Bash", input: { command: "   " } },
          ],
        },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onToolUse).toHaveBeenCalledWith({
      name: "Bash",
      input: { command: "   " },
    });
  });

  it("handles split JSONL lines across multiple stdout chunks", async () => {
    const child = makeFakeChild();
    const onAssistantText = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onAssistantText,
    });
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "split-line" }] },
    });
    child.stdout.write(line.slice(0, 10));
    child.stdout.write(line.slice(10) + "\n");
    finish(child);
    await promise;
    expect(onAssistantText).toHaveBeenCalledWith("split-line");
  });

  it("ignores malformed JSON lines without throwing", async () => {
    const child = makeFakeChild();
    const onAssistantText = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onAssistantText,
    });
    child.stdout.write("not json\n");
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onAssistantText).toHaveBeenCalledWith("ok");
  });

  it("streams stderr chunks to onStderr", async () => {
    const child = makeFakeChild();
    const onStderr = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onStderr,
    });
    child.stderr.write("oops");
    finish(child, 1);
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(onStderr).toHaveBeenCalledWith("oops");
  });

  it("rejects with MissingCliError when the executable is absent", async () => {
    const child = makeFakeChild();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });
    child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
    await expect(promise).rejects.toMatchObject({
      name: "MissingCliError",
      cli: "claude",
    });
  });

  it("rejects with the original error for non-ENOENT spawn failures", async () => {
    const child = makeFakeChild();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });
    child.emit("error", new Error("EACCES: permission denied"));
    await expect(promise).rejects.toThrow(/permission denied/);
  });

  it("kills the child with SIGTERM when signal is aborted", async () => {
    const child = makeFakeChild();
    const controller = new AbortController();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      signal: controller.signal,
    });
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    finish(child, null);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with AbortError if the signal is already aborted before spawn ends", async () => {
    const child = makeFakeChild();
    const controller = new AbortController();
    controller.abort();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      signal: controller.signal,
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    finish(child, null);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("escalates to SIGKILL if the child does not exit within the grace period", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const controller = new AbortController();
      const promise = runClaude({
        prompt: "x",
        cwd: "/tmp",
        spawnFn: (() => child) as never,
        signal: controller.signal,
      });
      controller.abort();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      vi.advanceTimersByTime(2500);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      finish(child, null);
      await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with TimeoutError when timeoutMs elapses", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const promise = runClaude({
        prompt: "x",
        cwd: "/tmp",
        timeoutMs: 500,
        spawnFn: (() => child) as never,
      });
      vi.advanceTimersByTime(600);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      vi.advanceTimersByTime(2100);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      finish(child, null);
      await expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats null exit code as -1", async () => {
    const child = makeFakeChild();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });
    finish(child, null);
    const result = await promise;
    expect(result.exitCode).toBe(-1);
  });
});
