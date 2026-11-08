import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  forkSession: vi.fn(async (_id: string, _options?: { dir?: string }) => ({ sessionId: "claude-fork" })),
  deleteSession: vi.fn(async (_id: string, _options?: { dir?: string }) => {}),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await original<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  forkSession: sdk.forkSession,
  deleteSession: sdk.deleteSession,
}));

import { AbortError, deleteClaudeSession, forkClaudeSession, forkCodexThread, TimeoutError } from "../src/index.js";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

/** An app-server that answers initialize, and thread/fork as `fork` says;
 * undefined leaves the fork unanswered. `initialize` waits `initDelayMs`, or
 * forever with null; `fork` waits `forkDelayMs`. */
function fakeAppServer(
  fork: (params: Record<string, unknown> | undefined) => unknown,
  timing: { initDelayMs?: number | null; forkDelayMs?: number } = {},
) {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  const requests: RpcMessage[] = [];
  let buffer = "";
  const reply = (message: Record<string, unknown>) => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const message = JSON.parse(line) as RpcMessage;
      requests.push(message);
      if (message.method === "initialize" && timing.initDelayMs !== null) {
        setTimeout(() => reply({ id: message.id, result: {} }), timing.initDelayMs ?? 0);
      }
      if (message.method === "thread/fork") {
        const answer = fork(message.params);
        setTimeout(() => {
          if (answer instanceof Error) reply({ id: message.id, error: { code: -32600, message: answer.message } });
          else if (answer !== undefined) reply({ id: message.id, result: answer });
        }, timing.forkDelayMs ?? 0);
      }
    }
  });
  const spawnFn = vi.fn(() => child);
  return { child, requests, spawnFn: spawnFn as never, spawned: spawnFn };
}

describe("lasting Codex forks", () => {
  it("forks the thread to be kept, answers its id, and closes the app-server", async () => {
    const server = fakeAppServer(() => ({ thread: { id: "codex-fork" } }));

    await expect(forkCodexThread({
      threadId: "codex-source",
      cwd: "/work",
      executablePath: "/bin/codex",
      spawnFn: server.spawnFn,
    })).resolves.toBe("codex-fork");

    expect(server.spawned).toHaveBeenCalledWith("/bin/codex", ["app-server", "--stdio"], expect.objectContaining({ cwd: "/work" }));
    expect(server.requests.find(({ method }) => method === "thread/fork")?.params)
      .toEqual({ threadId: "codex-source", cwd: "/work", ephemeral: false });
    expect(server.child.kill).toHaveBeenCalled();
  });

  it("rejects, closing the app-server, when the fork fails or names no thread", async () => {
    const failing = fakeAppServer(() => new Error("no rollout found"));
    await expect(forkCodexThread({ threadId: "x", cwd: "/work", spawnFn: failing.spawnFn })).rejects.toThrow("no rollout found");
    expect(failing.child.kill).toHaveBeenCalled();

    const nameless = fakeAppServer(() => ({ thread: {} }));
    await expect(forkCodexThread({ threadId: "x", cwd: "/work", spawnFn: nameless.spawnFn })).rejects.toThrow(/thread id/);
    expect(nameless.child.kill).toHaveBeenCalled();
  });

  it("stops at its deadline", async () => {
    const hung = fakeAppServer(() => undefined);
    await expect(forkCodexThread({ threadId: "x", cwd: "/work", timeoutMs: 20, spawnFn: hung.spawnFn }))
      .rejects.toBeInstanceOf(TimeoutError);
    expect(hung.child.kill).toHaveBeenCalled();
  });

  it("gives starting the app-server and forking one deadline between them", async () => {
    const slow = fakeAppServer(() => ({ thread: { id: "late" } }), { initDelayMs: 70, forkDelayMs: 70 });
    await expect(forkCodexThread({ threadId: "x", cwd: "/work", timeoutMs: 100, spawnFn: slow.spawnFn }))
      .rejects.toBeInstanceOf(TimeoutError);
    expect(slow.child.kill).toHaveBeenCalled();
  });

  it("stops at once when aborted while the app-server starts", async () => {
    const starting = fakeAppServer(() => ({ thread: { id: "never" } }), { initDelayMs: null });
    const controller = new AbortController();
    const started = Date.now();
    const forking = forkCodexThread({ threadId: "x", cwd: "/work", timeoutMs: 5_000, signal: controller.signal, spawnFn: starting.spawnFn });
    await vi.waitFor(() => expect(starting.requests.some(({ method }) => method === "initialize")).toBe(true));
    controller.abort();
    await expect(forking).rejects.toBeInstanceOf(AbortError);
    // The app-server goes with it, not when its start would have timed out.
    expect(starting.child.kill).toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("stops when aborted, before or during the fork", async () => {
    const hung = fakeAppServer(() => undefined);
    const controller = new AbortController();
    const forking = forkCodexThread({ threadId: "x", cwd: "/work", signal: controller.signal, spawnFn: hung.spawnFn });
    await vi.waitFor(() => expect(hung.requests.some(({ method }) => method === "thread/fork")).toBe(true));
    controller.abort();
    await expect(forking).rejects.toBeInstanceOf(AbortError);
    expect(hung.child.kill).toHaveBeenCalled();

    const unused = fakeAppServer(() => ({ thread: { id: "never" } }));
    await expect(forkCodexThread({ threadId: "x", cwd: "/work", signal: AbortSignal.abort(), spawnFn: unused.spawnFn }))
      .rejects.toBeInstanceOf(AbortError);
    expect(unused.spawned).not.toHaveBeenCalled();
  });
});

describe("lasting Claude forks", () => {
  it("copies the session kept for the directory, and answers the copy's id", async () => {
    await expect(forkClaudeSession("claude-source", { cwd: "/work" })).resolves.toBe("claude-fork");
    expect(sdk.forkSession).toHaveBeenCalledWith("claude-source", { dir: "/work" });
  });

  it("deletes a session kept for the directory", async () => {
    await deleteClaudeSession("claude-fork", { cwd: "/work" });
    expect(sdk.deleteSession).toHaveBeenCalledWith("claude-fork", { dir: "/work" });
  });
});
