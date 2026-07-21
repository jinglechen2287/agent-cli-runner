import { EventEmitter } from "node:events";
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
  vi.useRealTimers();
});

describe("runCodex isolated mode", () => {
  it("keeps isolated metadata requests on ephemeral read-only codex exec", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const stdin = readAll(child.stdin);
    const run = runCodex({
      prompt: "title this thread",
      cwd: "/tmp",
      isolated: true,
      model: "gpt-test",
      developerInstructions: "Return a title",
      spawnFn: spawnFn as never,
    });

    const [command, args, options] = spawnFn.mock.calls[0]!;
    expect(command).toBe("codex");
    expect(args).toEqual(expect.arrayContaining([
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--model",
      "gpt-test",
      "-c",
      'developer_instructions="Return a title"',
    ]));
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(options).toMatchObject({ cwd: "/tmp" });

    child.stdout.write(`${JSON.stringify({
      type: "thread.started",
      thread_id: "ephemeral-thread",
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", id: "message", text: "A short title" },
    })}\n`);
    finish(child);

    await expect(run).resolves.toEqual({
      text: "A short title",
      exitCode: 0,
      sessionId: "ephemeral-thread",
    });
    await expect(stdin).resolves.toBe("title this thread");
  });

  it("rejects incompatible isolated options", async () => {
    await expect(runCodex({
      prompt: "x",
      cwd: "/tmp",
      isolated: true,
      resumeSessionId: "thread-1",
    })).rejects.toThrow(/cannot resume/i);
    await expect(runCodex({
      prompt: "x",
      cwd: "/tmp",
      isolated: true,
      dangerouslyBypassApprovalsAndSandbox: true,
    })).rejects.toThrow(/cannot bypass/i);
  });

  it("propagates stderr and missing executable failures", async () => {
    const child = makeFakeChild();
    const onStderr = vi.fn();
    const run = runCodex({
      prompt: "x",
      cwd: "/tmp",
      isolated: true,
      spawnFn: (() => child) as never,
      onStderr,
    });
    child.stderr.write("warning");
    const error = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    child.emit("error", error);

    await expect(run).rejects.toMatchObject({ name: "MissingCliError", cli: "codex" });
    expect(onStderr).toHaveBeenCalledWith("warning");
  });

  it("terminates an aborted isolated process", async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    const controller = new AbortController();
    const run = runCodex({
      prompt: "x",
      cwd: "/tmp",
      isolated: true,
      signal: controller.signal,
      spawnFn: (() => child) as never,
    });

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(2_500);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    finish(child, -1);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });

  it("times out an isolated process", async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    const run = runCodex({
      prompt: "x",
      cwd: "/tmp",
      isolated: true,
      timeoutMs: 500,
      spawnFn: (() => child) as never,
    });

    vi.advanceTimersByTime(600);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    finish(child, null);
    await expect(run).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
