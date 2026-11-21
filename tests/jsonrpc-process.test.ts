import { describe, expect, it, vi } from "vitest";
import { startJsonRpcProcess } from "../src/jsonrpc-process.js";
import { MissingCliError, TimeoutError } from "../src/errors.js";
import { captureRequests, makeFakeChild, send, type FakeChild } from "./helpers/fake-child.js";

function start(child: FakeChild, options: { jsonrpcField?: boolean; requestTimeoutMs?: number } = {}) {
  return startJsonRpcProcess({
    cli: "agy",
    label: "agy acp",
    command: "agy",
    args: ["acp"],
    cwd: "/tmp",
    env: {},
    spawnFn: (() => child) as never,
    ...options,
  });
}

describe("startJsonRpcProcess", () => {
  it("adds the jsonrpc field only when asked", async () => {
    const withField = makeFakeChild();
    const sent = captureRequests(withField, (message) => send(withField, { id: message.id, result: {} }));
    await start(withField, { jsonrpcField: true }).client.request("initialize", {});
    expect(sent[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize" });

    const without = makeFakeChild();
    const plain = captureRequests(without, (message) => send(without, { id: message.id, result: {} }));
    await start(without).client.request("initialize", {});
    expect(plain[0]).not.toHaveProperty("jsonrpc");
  });

  it("keeps a request with a null timeout open past the default timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const sent = captureRequests(child, () => {});
      const { client } = start(child, { requestTimeoutMs: 50 });
      const open = client.request("session/prompt", {}, null);
      const timed = expect(client.request("other", {})).rejects.toBeInstanceOf(TimeoutError);
      await vi.advanceTimersByTimeAsync(10_000);
      await timed;
      send(child, { id: sent[0]!.id, result: { stopReason: "end_turn" } });
      await expect(open).resolves.toEqual({ stopReason: "end_turn" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands non-JSON stdout lines to their handlers", async () => {
    const child = makeFakeChild();
    const { client } = start(child);
    const lines: string[] = [];
    client.onStdoutNonJson((line) => lines.push(line));
    child.stdout.write("Open the following link to authenticate: https://example.test\n");
    child.stdout.write(`${JSON.stringify({ method: "note", params: {} })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toEqual(["Open the following link to authenticate: https://example.test"]);
  });

  it("answers server requests that carry string ids", async () => {
    const child = makeFakeChild();
    const sent = captureRequests(child, () => {});
    const { client } = start(child, { jsonrpcField: true });
    client.onServerRequest(async (request) => ({ echoed: request.id }));
    send(child, { id: "7", method: "session/request_permission", params: {} });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ jsonrpc: "2.0", id: "7", result: { echoed: "7" } });
  });

  it("names the CLI in a missing-binary error", () => {
    const enoent = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
    expect(() => startJsonRpcProcess({
      cli: "agy",
      label: "agy acp",
      command: "agy",
      args: ["acp"],
      cwd: "/tmp",
      env: {},
      spawnFn: (() => { throw enoent; }) as never,
    })).toThrow(MissingCliError);
  });
});
