/**
 * A newline-delimited JSON-RPC connection to one CLI process: requests,
 * notifications, server-initiated requests, and the process's lifecycle.
 * Shared by Codex's app-server and agy's ACP server; each provider runs its
 * own handshake on top.
 */
import { UnsupportedServerRequestError, MissingCliError, TimeoutError } from "./errors.js";
import { createDeferred, isRecord, safeCallback } from "./internal.js";
import {
  createChunkDecoder,
  createLineSplitter,
  isMissingExecutable,
  signalProcessTree,
  spawnCli,
  terminateTree,
} from "./process.js";
import type { AgentProvider } from "./providers.js";
import type { SpawnFn } from "./types.js";

interface JsonRpcMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface JsonRpcServerRequest {
  id: number | string;
  method: string;
  params: unknown;
}

export type JsonRpcServerRequestHandler = (
  request: JsonRpcServerRequest,
) => Promise<unknown> | unknown;

export interface JsonRpcClient {
  /** `timeoutMs` null sends the request with no timer at all (a request that
   * stays open for a whole turn); undefined uses the client's default. */
  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number | null,
  ): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  /** Register the single handler that answers server-initiated requests.
   * Only one registration may be active at a time: a second call throws
   * while the first is live, and the slot reopens once the returned
   * disposer runs. */
  onServerRequest(handler: JsonRpcServerRequestHandler): () => void;
  onStderr(handler: (chunk: string) => void): () => void;
  /** A stdout line that is not JSON, e.g. a sign-in link a CLI prints. */
  onStdoutNonJson(handler: (line: string) => void): () => void;
  onClose(handler: (error: Error) => void): () => void;
  close(): void;
}

export interface StartJsonRpcProcessOptions {
  /** Names the CLI in a MissingCliError. */
  cli: AgentProvider;
  /** Names the process in error messages, e.g. "Codex app-server". */
  label: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnFn: SpawnFn;
  requestTimeoutMs?: number;
  /** Adds `"jsonrpc": "2.0"` to every outgoing message. */
  jsonrpcField?: boolean;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** A JSON-RPC error object as an Error, keeping its `code` and `data`. */
export function rpcError(value: unknown, fallback: string): Error {
  if (!isRecord(value)) return new Error(fallback);
  const message = typeof value.message === "string" ? value.message : fallback;
  const error = new Error(message) as Error & { code?: unknown; data?: unknown };
  if (value.code !== undefined) error.code = value.code;
  if (value.data !== undefined) error.data = value.data;
  return error;
}

/** Spawn a CLI that speaks JSON-RPC on stdio. `whenExited` settles once the
 * process has exited or, after `close()`, once termination gave up waiting:
 * the same promise for the life of the client. */
export function startJsonRpcProcess(
  options: StartJsonRpcProcessOptions,
): { client: JsonRpcClient; whenExited: Promise<void> } {
  const { label } = options;
  const child = spawnCli({
    cli: options.cli,
    spawnFn: options.spawnFn,
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
  });

  const pending = new Map<number, PendingRequest>();
  const notificationHandlers = new Set<(method: string, params: unknown) => void>();
  // Exactly one handler can answer a server request; registering a second one
  // while the first is live throws rather than silently ignoring it. Each
  // registration gets its own token so a stale disposer (from a disposed
  // registration of the same handler instance) can never clear a newer one.
  let serverRequestRegistration: { handler: JsonRpcServerRequestHandler } | undefined;
  const stderrHandlers = new Set<(chunk: string) => void>();
  const nonJsonHandlers = new Set<(line: string) => void>();
  const closeHandlers = new Set<(error: Error) => void>();
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let nextId = 1;
  let closed = false;
  let closeError: Error | undefined;
  let terminationRequested = false;
  let stderr = "";
  /** Settled by the process closing or, once close() has asked it to go, by
   * termination giving up on it. Settled before that only by a real close. */
  const whenExited = createDeferred();

  const send = (message: Record<string, unknown>): void => {
    if (closed) return;
    const framed = options.jsonrpcField ? { jsonrpc: "2.0", ...message } : message;
    child.stdin?.write(`${JSON.stringify(framed)}\n`);
  };

  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  const fail = (error: Error): void => {
    if (closed) return;
    closed = true;
    closeError = error;
    rejectPending(error);
    for (const handler of closeHandlers) safeCallback(() => handler(error));
  };

  const respondToServerRequest = async (message: JsonRpcMessage): Promise<void> => {
    const id = message.id;
    const method = message.method;
    if ((typeof id !== "number" && typeof id !== "string") || typeof method !== "string") return;
    const handler = serverRequestRegistration?.handler;
    if (!handler) {
      send({
        id,
        error: { code: -32601, message: `Unsupported server request: ${method}` },
      });
      return;
    }
    try {
      const result = await handler({ id, method, params: message.params });
      send({ id, result: result ?? null });
    } catch (error) {
      if (error instanceof UnsupportedServerRequestError) {
        send({ id, error: { code: -32601, message: error.message } });
        return;
      }
      send({
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Server request handler failed",
        },
      });
    }
  };

  const handleLine = (line: string): void => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      if (line.trim()) for (const handler of nonJsonHandlers) safeCallback(() => handler(line));
      return;
    }
    if (!isRecord(message)) return;

    if (typeof message.method === "string" && message.id !== undefined) {
      void respondToServerRequest(message);
      return;
    }
    if (typeof message.method === "string") {
      for (const handler of notificationHandlers) {
        safeCallback(() => handler(message.method as string, message.params));
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error !== undefined) {
      request.reject(rpcError(message.error, `${label} request failed`));
    } else {
      request.resolve(message.result);
    }
  };

  const splitter = createLineSplitter(handleLine);
  child.stdout?.on("data", (chunk: Buffer | string) => splitter.push(chunk));
  const stderrDecoder = createChunkDecoder((text) => {
    stderr = (stderr + text).slice(-4_000);
    for (const handler of stderrHandlers) safeCallback(() => handler(text));
  });
  child.stderr?.on("data", (chunk: Buffer | string) => stderrDecoder.push(chunk));
  child.stdin?.on("error", (error: Error) => fail(error));
  child.stdout?.on("error", (error: Error) => fail(error));
  child.stderr?.on("error", (error: Error) => fail(error));
  child.on("error", (error: Error) => {
    fail(isMissingExecutable(error) ? new MissingCliError(options.cli) : error);
  });
  child.on("close", (code) => {
    whenExited.resolve();
    splitter.flush();
    stderrDecoder.flush();
    const detail = stderr.trim();
    fail(new Error(
      `${label} exited${code === null ? "" : ` with code ${code}`}${detail ? `: ${detail}` : ""}`,
    ));
  });

  const client: JsonRpcClient = {
    request(method, params = {}, requestTimeoutMs) {
      if (closed) return Promise.reject(new Error(`${label} is closed`));
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        const limit = requestTimeoutMs === undefined ? timeoutMs : requestTimeoutMs;
        const timer = limit === null
          ? undefined
          : setTimeout(() => {
              pending.delete(id);
              reject(new TimeoutError(`${label} request timed out: ${method}`));
            }, limit);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    },
    notify(method, params) {
      send({ method, params: params ?? {} });
    },
    onNotification(handler) {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    onServerRequest(handler) {
      if (serverRequestRegistration) {
        throw new Error(
          `${label} client already has a server request handler — remove it first`,
        );
      }
      const registration = { handler };
      serverRequestRegistration = registration;
      return () => {
        if (serverRequestRegistration === registration) serverRequestRegistration = undefined;
      };
    },
    onStderr(handler) {
      stderrHandlers.add(handler);
      return () => stderrHandlers.delete(handler);
    },
    onStdoutNonJson(handler) {
      nonJsonHandlers.add(handler);
      return () => nonJsonHandlers.delete(handler);
    },
    onClose(handler) {
      if (closed) {
        safeCallback(() => handler(closeError ?? new Error(`${label} is closed`)));
        return () => {};
      }
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close() {
      if (terminationRequested || whenExited.settled) return;
      terminationRequested = true;
      if (!closed) fail(new Error(`${label} was closed`));
      void terminateTree((signal) => signalProcessTree(child, signal), whenExited, { unref: true })
        .then(whenExited.resolve);
    },
  };

  return { client, whenExited: whenExited.promise };
}
