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
      [{ name: "Bash" }],
      [{ name: "Edit" }],
      [{ name: "TodoWrite" }],
    ]);
    expect(result).toEqual({ text: "Done", exitCode: 0, sessionId: "thread-1" });
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
