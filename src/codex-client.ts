/**
 * A JSON-RPC connection to one `codex app-server --stdio` process: requests,
 * notifications, server-initiated requests, and the process's lifecycle.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { version } from "../package.json";
import { AbortError, MissingCliError, TimeoutError, UnsupportedServerRequestError } from "./errors.js";
import { createDeferred, isRecord, safeCallback } from "./internal.js";
import {
  childEnv,
  createChunkDecoder,
  createLineSplitter,
  isMissingExecutable,
  signalProcessTree,
  spawnCli,
  terminateTree,
} from "./process.js";
import type { RunCodexOptions } from "./run-codex.js";

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
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexServerRequest {
  id: number | string;
  method: string;
  params: unknown;
}

export type CodexServerRequestHandler = (
  request: CodexServerRequest,
) => Promise<unknown> | unknown;

export interface CodexAppServerClient {
  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  /** Register the single handler that answers server-initiated requests.
   * Only one registration may be active at a time: a second call throws
   * while the first is live, and the slot reopens once the returned
   * disposer runs. */
  onServerRequest(handler: CodexServerRequestHandler): () => void;
  onStderr(handler: (chunk: string) => void): () => void;
  onClose(handler: (error: Error) => void): () => void;
  close(): void;
}

export interface CreateCodexAppServerClientOptions {
  executablePath?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: RunCodexOptions["spawnFn"];
  requestTimeoutMs?: number;
  /** MCP extensions this client supports, declared at `initialize`. */
  extensions?: { [id: string]: CodexJsonValue };
  /** Gives up on starting: closes the app-server and rejects with
   * `AbortError`. Only the start; close the client to stop it after. */
  signal?: AbortSignal;
}

/** app-server's `config` map: dotted or nested config.toml keys to values. */
export type CodexConfigOverrides = { [key: string]: CodexJsonValue };
export type CodexJsonValue =
  | string
  | number
  | boolean
  | null
  | CodexJsonValue[]
  | { [key: string]: CodexJsonValue };

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const CLIENT_INFO = {
  name: "agent_cli_runner",
  title: "Agent CLI Runner",
  version,
};

function rpcError(value: unknown, fallback: string): Error {
  if (!isRecord(value)) return new Error(fallback);
  const message = typeof value.message === "string" ? value.message : fallback;
  const error = new Error(message) as Error & { code?: unknown; data?: unknown };
  if (value.code !== undefined) error.code = value.code;
  if (value.data !== undefined) error.data = value.data;
  return error;
}

/** Start an app-server and initialize it. `whenExited` settles once the process
 * has exited or, after `close()`, once termination gave up waiting: the same
 * promise for the life of the client. */
export async function startCodexAppServer(
  options: CreateCodexAppServerClientOptions,
): Promise<{ client: CodexAppServerClient; whenExited: Promise<void> }> {
  const child = spawnCli({
    cli: "codex",
    spawnFn: options.spawnFn ?? nodeSpawn,
    command: options.executablePath ?? "codex",
    args: ["app-server", "--stdio"],
    cwd: options.cwd,
    env: childEnv("codex", options.env ?? process.env),
  });

  const pending = new Map<number, PendingRequest>();
  const notificationHandlers = new Set<(method: string, params: unknown) => void>();
  // Exactly one handler can answer a server request; registering a second one
  // while the first is live throws rather than silently ignoring it. Each
  // registration gets its own token so a stale disposer (from a disposed
  // registration of the same handler instance) can never clear a newer one.
  let serverRequestRegistration: { handler: CodexServerRequestHandler } | undefined;
  const stderrHandlers = new Set<(chunk: string) => void>();
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
    child.stdin?.write(`${JSON.stringify(message)}\n`);
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
      return;
    }

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
      request.reject(rpcError(message.error, "Codex app-server request failed"));
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
    fail(isMissingExecutable(error) ? new MissingCliError("codex") : error);
  });
  child.on("close", (code) => {
    whenExited.resolve();
    splitter.flush();
    stderrDecoder.flush();
    const detail = stderr.trim();
    fail(new Error(
      `Codex app-server exited${code === null ? "" : ` with code ${code}`}${detail ? `: ${detail}` : ""}`,
    ));
  });

  const client: CodexAppServerClient = {
    request(method, params = {}, requestTimeoutMs) {
      if (closed) return Promise.reject(new Error("Codex app-server is closed"));
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new TimeoutError(`Codex app-server request timed out: ${method}`));
        }, requestTimeoutMs ?? timeoutMs);
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
          "Codex app-server client already has a server request handler — remove it first",
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
    onClose(handler) {
      if (closed) {
        safeCallback(() => handler(closeError ?? new Error("Codex app-server is closed")));
        return () => {};
      }
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close() {
      if (terminationRequested || whenExited.settled) return;
      terminationRequested = true;
      if (!closed) fail(new Error("Codex app-server was closed"));
      void terminateTree((signal) => signalProcessTree(child, signal), whenExited, { unref: true })
        .then(whenExited.resolve);
    },
  };

  const abort = () => client.close();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) throw new AbortError();
    await client.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
        ...(options.extensions ? { extensions: options.extensions } : {}),
      },
    });
    client.notify("initialized", {});
    return { client, whenExited: whenExited.promise };
  } catch (error) {
    client.close();
    throw options.signal?.aborted ? new AbortError() : error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function createCodexAppServerClient(
  options: CreateCodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  return (await startCodexAppServer(options)).client;
}
