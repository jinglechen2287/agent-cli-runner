import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { vi, type Mock } from "vitest";

/** A child process with real pipes, and a kill the test can watch. */
export interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: Mock;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

/** With `exitOnKill`, kill() makes the child exit on the next microtask, as a
 * process that dies at once would. Without it, the test drives the exit. */
export function makeFakeChild({ exitOnKill = false }: { exitOnKill?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = exitOnKill
    ? vi.fn(() => {
        queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
        return true;
      })
    : vi.fn();
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

/** One JSON-RPC message, as either side writes it. */
export interface RpcMessage {
  id?: number | undefined;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** Write a message to the child's stdout, as the app-server would. */
export function send(child: FakeChild, message: RpcMessage): void {
  child.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Collect every message the runner writes to the child's stdin, in order,
 * handing each to `handle` as it arrives. */
export function captureRequests(
  child: FakeChild,
  handle: (message: RpcMessage) => void,
): RpcMessage[] {
  const requests: RpcMessage[] = [];
  let buffer = "";
  // Decoded by the stream, so a character split across writes arrives whole.
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const message = JSON.parse(line) as RpcMessage;
      requests.push(message);
      handle(message);
    }
  });
  return requests;
}
