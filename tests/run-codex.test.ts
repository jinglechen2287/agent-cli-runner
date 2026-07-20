import { EventEmitter } from "node:events";
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodex } from "../src/index.js";

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

describe("runCodex", () => {
  it("starts a full-access JSONL run and passes the prompt via stdin", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const stdinData = readAll(child.stdin);
    const promise = runCodex({
      prompt: "make it round",
      cwd: "/tmp/proj",
      developerInstructions: "carve rules",
      dangerouslyBypassApprovalsAndSandbox: true,
      spawnFn: spawnFn as never,
    });

    const [command, args, options] = spawnFn.mock.calls[0]!;
    expect(command).toBe("codex");
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("-c");
    expect(args).toContain('developer_instructions="carve rules"');
    expect(args[args.length - 1]).toBe("-");
    expect(args).not.toContain("make it round");
    expect(args).not.toContain("--");
    expect(options).toMatchObject({ cwd: "/tmp/proj" });

    finish(child);
    await expect(promise).resolves.toMatchObject({ exitCode: 0 });
    await expect(stdinData).resolves.toBe("make it round");
  });

  it("does not bypass approvals or the sandbox unless explicitly opted in", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain("--skip-git-repo-check");
    finish(child);
    await promise;
  });

  it("runs isolated one-shot requests read-only without config, rules, or persistence", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runCodex({
      prompt: "title this",
      cwd: "/tmp",
      isolated: true,
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    expect(args).toEqual(expect.arrayContaining([
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
    ]));
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    finish(child);
    await promise;
  });

  it("rejects instead of throwing when spawnFn throws synchronously", async () => {
    await expect(
      runCodex({
        prompt: "x",
        cwd: "/tmp",
        spawnFn: (() => {
          throw new Error("sync spawn failure");
        }) as never,
      }),
    ).rejects.toThrow(/sync spawn failure/);
  });

  it("omits developer_instructions when none are given", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    expect(args).not.toContain("-c");
    expect(args.join(" ")).not.toContain("developer_instructions");
    finish(child);
    await promise;
  });

  it("spawns a custom executable path when given", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runCodex({
      prompt: "x",
      cwd: "/tmp",
      executablePath: "/opt/bin/codex-dev",
      spawnFn: spawnFn as never,
    });
    expect(spawnFn.mock.calls[0]![0]).toBe("/opt/bin/codex-dev");
    finish(child);
    await promise;
  });

  it("strips CODEX_THREAD_ID from the spawn environment", async () => {
    vi.stubEnv("CODEX_THREAD_ID", "parent-thread");
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runCodex({ prompt: "x", cwd: "/tmp", spawnFn: spawnFn as never });
    const env = spawnFn.mock.calls[0]![2].env as Record<string, string>;
    expect(env).not.toHaveProperty("CODEX_THREAD_ID");
    expect(env.PATH).toBe(process.env.PATH);
    finish(child);
    await promise;
  });

  it("resumes the requested thread with repeated images, keeping stdin sentinel last", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runCodex({
      prompt: "follow up",
      cwd: "/tmp/proj",
      developerInstructions: "line one\nline two",
      resumeSessionId: "thread-123",
      imagePaths: ["/tmp/a.png", "/tmp/b.jpg"],
      dangerouslyBypassApprovalsAndSandbox: true,
      spawnFn: spawnFn as never,
    });

    const [, args] = spawnFn.mock.calls[0]!;
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain('developer_instructions="line one\\nline two"');
    expect(args.filter((arg: string) => arg === "-i")).toHaveLength(2);
    expect(args.slice(-2)).toEqual(["thread-123", "-"]);

    finish(child);
    await promise;
  });

  it("emits the thread id, assistant text, and deduplicated tool activity", async () => {
    const child = makeFakeChild();
    const onSessionId = vi.fn();
    const onAssistantText = vi.fn();
    const onToolUse = vi.fn();
    const promise = runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onSessionId,
      onAssistantText,
      onToolUse,
    });

    const events = [
      { type: "thread.started", thread_id: "thread-1" },
      {
        type: "item.started",
        item: { id: "tool-1", type: "command_execution", command: "pnpm test" },
      },
      {
        type: "item.completed",
        item: { id: "tool-1", type: "command_execution", command: "pnpm test" },
      },
      {
        type: "item.completed",
        item: { id: "tool-2", type: "file_change", changes: [] },
      },
      {
        type: "item.completed",
        item: { id: "tool-3", type: "todo_list", items: [] },
      },
      {
        type: "item.completed",
        item: { id: "message-1", type: "agent_message", text: "Done" },
      },
    ];
    for (const event of events) child.stdout.write(JSON.stringify(event) + "\n");
    finish(child);
    const result = await promise;

    expect(onSessionId).toHaveBeenCalledWith("thread-1");
    expect(onAssistantText).toHaveBeenCalledWith("Done");
    expect(onToolUse.mock.calls).toEqual([
      [
        {
          callId: "tool-1",
          name: "Bash",
          summary: "pnpm test",
          input: { id: "tool-1", type: "command_execution", command: "pnpm test" },
        },
      ],
      [{
        callId: "tool-2",
        name: "Edit",
        input: { id: "tool-2", type: "file_change", changes: [] },
      }],
      [{
        callId: "tool-3",
        name: "TodoWrite",
        input: { id: "tool-3", type: "todo_list", items: [] },
      }],
    ]);
    expect(result).toEqual({ text: "Done", exitCode: 0, sessionId: "thread-1" });
  });

  it("reports the app-server's last-request usage and authoritative window", async () => {
    const child = makeFakeChild();
    const appServer = makeFakeChild();
    let appServerInput = "";
    appServer.stdin.on("data", (chunk: Buffer | string) => {
      appServerInput += chunk.toString();
    });
    const onUsage = vi.fn(() => {
      throw new Error("host callback failed");
    });
    const spawnFn = vi.fn()
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(appServer);
    const promise = runCodex({
      prompt: "x",
      cwd: "/tmp",
      model: "gpt-5.6-sol",
      spawnFn: spawnFn as never,
      onUsage,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-sol");

    child.stdout.write(
      JSON.stringify({ type: "thread.started", thread_id: "t1" }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 503237,
          cached_input_tokens: 451328,
          output_tokens: 3737,
          reasoning_output_tokens: 1576,
        },
      }) + "\n",
    );
    finish(child);

    expect(spawnFn.mock.calls[1]?.[1]).toEqual(["app-server", "--stdio"]);
    expect(appServer.stderr.readableFlowing).toBe(true);
    appServer.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
    appServer.stdout.write(
      JSON.stringify({ id: 2, result: { model: "gpt-5.6-sol" } }) + "\n",
    );
    appServer.stdout.write(
      JSON.stringify({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              totalTokens: 506974,
              inputTokens: 503237,
              cachedInputTokens: 451328,
              outputTokens: 3737,
              reasoningOutputTokens: 1576,
            },
            last: {
              totalTokens: 52721,
              inputTokens: 51718,
              cachedInputTokens: 49920,
              outputTokens: 1003,
              reasoningOutputTokens: 516,
            },
            modelContextWindow: 258400,
          },
        },
      }) + "\n",
    );
    const result = await promise;

    const usage = {
      contextTokens: 52721,
      inputTokens: 51718 - 49920,
      cachedInputTokens: 49920,
      outputTokens: 1003,
      model: "gpt-5.6-sol",
      contextWindow: 258400,
    };
    expect(onUsage).toHaveBeenCalledWith(usage);
    expect(result.usage).toEqual(usage);
    expect(appServer.kill).toHaveBeenCalledWith("SIGTERM");
    const requests = appServerInput.trim().split("\n").map((line) => JSON.parse(line));
    expect(requests[2]).toEqual({
      id: 2,
      method: "thread/resume",
      params: { threadId: "t1" },
    });
  });

  it("omits usage instead of treating cumulative turn totals as occupancy", async () => {
    const child = makeFakeChild();
    const appServer = makeFakeChild();
    const onUsage = vi.fn();
    const spawnFn = vi.fn()
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(appServer);
    const promise = runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: spawnFn as never,
      onUsage,
    });
    child.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t1" }) + "\n");
    child.stdout.write(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 },
      }) + "\n",
    );
    finish(child);
    appServer.emit("error", Object.assign(new Error("unsupported"), { code: "ENOENT" }));
    const result = await promise;
    expect(onUsage).not.toHaveBeenCalled();
    expect(result.usage).toBeUndefined();
  });

  it("uses an explicit window only when app-server reports none", async () => {
    const child = makeFakeChild();
    const appServer = makeFakeChild();
    const onUsage = vi.fn();
    const spawnFn = vi.fn()
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(appServer);
    const promise = runCodex({
      prompt: "x",
      cwd: "/tmp",
      contextWindow: 500_000,
      spawnFn: spawnFn as never,
      onUsage,
    });
    child.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t1" }) + "\n");
    child.stdout.write(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, output_tokens: 10 },
      }) + "\n",
    );
    finish(child);
    appServer.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\n");
    appServer.stdout.write(JSON.stringify({ id: 2, result: { model: "mystery" } }) + "\n");
    appServer.stdout.write(
      JSON.stringify({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              totalTokens: 110,
              inputTokens: 100,
              cachedInputTokens: 0,
              outputTokens: 10,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 60,
              inputTokens: 50,
              cachedInputTokens: 40,
              outputTokens: 10,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: null,
          },
        },
      }) + "\n",
    );
    await promise;
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        contextTokens: 60,
        contextWindow: 500_000,
        cachedInputTokens: 40,
      }),
    );
  });

  it("summarizes a single file change by its path and a search by its query", async () => {
    const child = makeFakeChild();
    const onToolUse = vi.fn();
    const promise = runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onToolUse,
    });

    const events = [
      {
        type: "item.completed",
        item: {
          id: "f1",
          type: "file_change",
          changes: [{ path: "src/app.ts", kind: "modified" }],
        },
      },
      {
        type: "item.completed",
        item: { id: "s1", type: "web_search", query: "codex json schema" },
      },
    ];
    for (const event of events) child.stdout.write(JSON.stringify(event) + "\n");
    finish(child);
    await promise;

    expect(onToolUse.mock.calls.map(([info]) => info)).toEqual([
      {
        callId: "f1",
        name: "Edit",
        summary: "src/app.ts",
        input: {
          id: "f1",
          type: "file_change",
          changes: [{ path: "src/app.ts", kind: "modified" }],
        },
      },
      {
        callId: "s1",
        name: "WebSearch",
        summary: "codex json schema",
        input: { id: "s1", type: "web_search", query: "codex json schema" },
      },
    ]);
  });

  it("resolves a web_search query nested under action, exposing it on the input", async () => {
    const child = makeFakeChild();
    const onToolUse = vi.fn();
    const promise = runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onToolUse,
    });

    child.stdout.write(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "s2",
          type: "web_search",
          action: {
            type: "search",
            query: "figma monthly active users 2025",
            queries: ["figma monthly active users 2025", "figma s-1 mau"],
          },
        },
      }) + "\n",
    );
    finish(child);
    await promise;

    const [info] = onToolUse.mock.calls.at(-1)!;
    expect(info.name).toBe("WebSearch");
    expect(info.summary).toBe("figma monthly active users 2025");
    // toolCallDetails reads input.query, so it must be surfaced there too.
    expect((info.input as { query?: string }).query).toBe("figma monthly active users 2025");
  });

  it("falls back to the first of action.queries when no single query is set", async () => {
    const child = makeFakeChild();
    const onToolUse = vi.fn();
    const promise = runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onToolUse,
    });

    child.stdout.write(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "s3",
          type: "web_search",
          action: { type: "search", queries: ["first query", "second query"] },
        },
      }) + "\n",
    );
    finish(child);
    await promise;

    const [info] = onToolUse.mock.calls.at(-1)!;
    expect(info.summary).toBe("first query");
    expect((info.input as { query?: string }).query).toBe("first query");
  });

  it("normalizes current todo_list and legacy plan_update items", async () => {
    const child = makeFakeChild();
    const onToolUse = vi.fn();
    const promise = runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onToolUse,
    });

    const events = [
      {
        type: "item.started",
        item: {
          id: "todo-1",
          type: "todo_list",
          items: [
            { text: "Inspect repository", completed: true },
            { text: "Implement support", completed: false },
            { text: "Verify tests", completed: false },
          ],
        },
      },
      {
        type: "item.completed",
        item: {
          id: "plan-bad",
          type: "plan_update",
          plan: [
            { step: "Valid step", status: "completed" },
            { step: "Missing status" },
          ],
        },
      },
      {
        type: "item.completed",
        item: {
          id: "plan-1",
          type: "plan_update",
          plan: [
            { step: "Inspect repository", status: "completed" },
            { step: "Implement support", status: "in_progress" },
            { step: "Verify tests", status: "pending" },
          ],
        },
      },
    ];
    for (const event of events) child.stdout.write(JSON.stringify(event) + "\n");
    finish(child);
    await promise;

    expect(onToolUse.mock.calls.map(([info]) => info)).toEqual([
      {
        callId: "todo-1",
        name: "TodoWrite",
        summary: "1/3 steps completed",
        planItems: [
          { text: "Inspect repository", status: "completed" },
          { text: "Implement support", status: "pending" },
          { text: "Verify tests", status: "pending" },
        ],
        input: events[0]?.item,
      },
      {
        callId: "plan-bad",
        name: "TodoWrite",
        input: events[1]?.item,
      },
      {
        callId: "plan-1",
        name: "TodoWrite",
        summary: "1/3 steps completed",
        planItems: [
          { text: "Inspect repository", status: "completed" },
          { text: "Implement support", status: "in_progress" },
          { text: "Verify tests", status: "pending" },
        ],
        input: events[2]?.item,
      },
    ]);
  });

  it.each([
    [{ type: "error", message: "request failed" }, /request failed/],
    [
      { type: "turn.failed", error: { message: "model unavailable" } },
      /model unavailable/,
    ],
  ])("rejects fatal %s events even when Codex exits zero", async (event, message) => {
    const child = makeFakeChild();
    const promise = runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });
    child.stdout.write(JSON.stringify(event) + "\n");
    finish(child, 0);
    await expect(promise).rejects.toThrow(message);
    await expect(promise).rejects.toMatchObject({ name: "CodexTurnError" });
  });

  it("attaches the exit code to fatal turn errors", async () => {
    const child = makeFakeChild();
    const promise = runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });
    child.stdout.write(JSON.stringify({ type: "error", message: "rate limited" }) + "\n");
    finish(child, 7);
    await expect(promise).rejects.toMatchObject({
      name: "CodexTurnError",
      exitCode: 7,
    });
  });

  it("handles split and malformed JSONL without dropping the next event", async () => {
    const child = makeFakeChild();
    const onAssistantText = vi.fn();
    const promise = runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onAssistantText,
    });
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "message", type: "agent_message", text: "split" },
    });
    child.stdout.write("not json\n" + line.slice(0, 12));
    child.stdout.write(line.slice(12) + "\n");
    finish(child);
    await promise;
    expect(onAssistantText).toHaveBeenCalledWith("split");
  });

  it("streams stderr and returns non-zero exit codes", async () => {
    const child = makeFakeChild();
    const onStderr = vi.fn();
    const promise = runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onStderr,
    });
    child.stderr.write("auth failed");
    finish(child, 1);
    await expect(promise).resolves.toMatchObject({ exitCode: 1 });
    expect(onStderr).toHaveBeenCalledWith("auth failed");
  });

  it("rejects with MissingCliError when the executable is absent", async () => {
    const child = makeFakeChild();
    const promise = runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });
    const error = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    child.emit("error", error);
    await expect(promise).rejects.toMatchObject({ name: "MissingCliError", cli: "codex" });
    await expect(promise).rejects.toThrow(/codex.*not found/i);
  });

  it("spawns detached on POSIX so the process group can be signaled", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runCodex({ prompt: "x", cwd: "/tmp", spawnFn: spawnFn as never });
    const [, , options] = spawnFn.mock.calls[0]!;
    if (process.platform !== "win32") {
      expect(options).toMatchObject({ detached: true });
    }
    finish(child);
    await promise;
  });

  it("terminates and then kills an aborted run", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const controller = new AbortController();
      const promise = runCodex({
        prompt: "x",
        cwd: "/tmp",
        spawnFn: (() => child) as never,
        signal: controller.signal,
      });
      controller.abort();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      vi.advanceTimersByTime(2500);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      finish(child, -1);
      await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with TimeoutError when timeoutMs elapses", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const promise = runCodex({
        prompt: "x",
        cwd: "/tmp",
        timeoutMs: 500,
        spawnFn: (() => child) as never,
      });
      vi.advanceTimersByTime(600);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      finish(child, null);
      await expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.runIf(process.platform !== "win32")(
    "terminates a spawned grandchild with the Codex process group",
    async () => {
      const controller = new AbortController();
      let resolveGrandchild!: (pid: number) => void;
      const grandchildPid = new Promise<number>((resolve) => {
        resolveGrandchild = resolve;
      });
      const parentScript = `
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: String(child.pid) }) + "\\n");
        setInterval(() => {}, 1000);
      `;
      const run = runCodex({
        prompt: "x",
        cwd: "/tmp",
        signal: controller.signal,
        spawnFn: ((
          _command: string,
          _args: readonly string[],
          options: SpawnOptions,
        ): ChildProcess =>
          nodeSpawn(process.execPath, ["-e", parentScript], options)) as never,
        onSessionId: (id) => resolveGrandchild(Number(id)),
      });

      let pid: number | undefined;
      try {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const discoveryTimeout = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("timed out waiting for grandchild pid")),
            1000,
          );
        });
        try {
          const discoveredPid = await Promise.race([
            grandchildPid,
            discoveryTimeout,
            run.then(
              () => Promise.reject(new Error("Codex exited before discovery")),
              (error: unknown) => Promise.reject(error),
            ),
          ]);
          pid = discoveredPid;
        } finally {
          if (timeout) clearTimeout(timeout);
        }
        const discoveredPid = pid;
        if (discoveredPid === undefined) {
          throw new Error("grandchild pid was not discovered");
        }
        expect(() => process.kill(discoveredPid, 0)).not.toThrow();
        controller.abort();
        await expect(run).rejects.toMatchObject({ name: "AbortError" });
        await vi.waitFor(() => {
          expect(() => process.kill(discoveredPid, 0)).toThrow();
        });
      } finally {
        controller.abort();
        await run.catch(() => {});
        if (pid !== undefined) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The process-group termination already removed it.
          }
        }
      }
    },
    5000,
  );
});
