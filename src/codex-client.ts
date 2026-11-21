/**
 * A JSON-RPC connection to one `codex app-server --stdio` process: requests,
 * notifications, server-initiated requests, and the process's lifecycle.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { version } from "../package.json";
import { AbortError } from "./errors.js";
import {
  startJsonRpcProcess,
  type JsonRpcClient,
  type JsonRpcServerRequest,
  type JsonRpcServerRequestHandler,
} from "./jsonrpc-process.js";
import { childEnv } from "./process.js";
import type { RunCodexOptions } from "./run-codex.js";

export type CodexServerRequest = JsonRpcServerRequest;
export type CodexServerRequestHandler = JsonRpcServerRequestHandler;
export type CodexAppServerClient = JsonRpcClient;

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

const CLIENT_INFO = {
  name: "agent_cli_runner",
  title: "Agent CLI Runner",
  version,
};

/** Start an app-server and initialize it. `whenExited` settles once the process
 * has exited or, after `close()`, once termination gave up waiting: the same
 * promise for the life of the client. */
export async function startCodexAppServer(
  options: CreateCodexAppServerClientOptions,
): Promise<{ client: CodexAppServerClient; whenExited: Promise<void> }> {
  const { client, whenExited } = startJsonRpcProcess({
    cli: "codex",
    label: "Codex app-server",
    spawnFn: options.spawnFn ?? nodeSpawn,
    command: options.executablePath ?? "codex",
    args: ["app-server", "--stdio"],
    cwd: options.cwd,
    env: childEnv("codex", options.env ?? process.env),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });

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
    return { client, whenExited };
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
