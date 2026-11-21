/**
 * Starts `agy acp` (Antigravity CLI's Agent Client Protocol server) and runs
 * its handshake: initialize, then sign-in. The handshake, the environment and
 * the sign-in detection follow T3 Code's agy driver.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { version } from "../package.json";
import { AbortError, AgyAuthError, AgyTurnError } from "./errors.js";
import { isRecord, raceTimeout } from "./internal.js";
import { startJsonRpcProcess, type JsonRpcClient } from "./jsonrpc-process.js";
import { childEnv } from "./process.js";
import type { SpawnFn } from "./types.js";

export interface StartAgyAcpOptions {
  executablePath?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
  /** Gives up on starting: closes the process and rejects with AbortError. */
  signal?: AbortSignal;
  /** agy's `--gemini-dir`; also exported to agy as GEMINI_HOME. */
  geminiDir?: string;
  /** agy's `--app-data-dir`, joined beneath the gemini dir. */
  appDataDir?: string;
  /** The ACP auth method to sign in with. Defaults to "oauth-personal". */
  authMethod?: string;
}

export interface AgyAgentInfo {
  version?: string;
  protocolVersion: number;
  /** initialize's `agentCapabilities`. */
  capabilities: Record<string, unknown>;
}

export interface StartedAgyAcp {
  client: JsonRpcClient;
  whenExited: Promise<void>;
  agent: AgyAgentInfo;
}

const INITIALIZE_TIMEOUT_MS = 90_000;
const AUTHENTICATE_TIMEOUT_MS = 30_000;
const MIN_AGY_VERSION: readonly [number, number, number] = [1, 5, 0];
const AUTH_LINK_PREFIX = "Open the following link to authenticate the ACP server: ";
const NO_BROWSER_PREFIX = "No browser is available here";
const BROWSER_MARKER = "__AGENT_CLI_RUNNER_AGY_AUTH_URL__";
const CLIENT_INFO = { name: "agent-cli-runner", title: "Agent CLI Runner", version };

// agy hands its sign-in link to $BROWSER. This helper prints the link to
// stderr with a marker instead of opening a browser on the host. Python-style
// BROWSER parsing splits on the path separator, so the command has none.
const BROWSER_HELPER_SOURCE =
  `process.stderr.on("error",()=>process.exit(0)).write(` +
  `"${BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",` +
  `()=>process.exit(0))`;

function quoteBrowserArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** The BROWSER command that catches agy's sign-in link, or undefined when
 * this runtime's path can't be put in one safely. */
export function agyBrowserCommand(execPath: string = process.execPath): string | undefined {
  const helper = process.platform === "win32" ? execPath.replaceAll("\\", "/") : execPath;
  const command = [helper, "-e", BROWSER_HELPER_SOURCE, "--", "%s"].map(quoteBrowserArgument).join(" ");
  const separator = process.platform === "win32" ? ";" : ":";
  if (command.includes(separator) || /[\r\n\0]/.test(helper) || helper.includes("%s")) return undefined;
  return command;
}

/** agy's argv and environment for one `agy acp` process. */
export function agyAcpLaunch(options: Pick<StartAgyAcpOptions, "env" | "geminiDir" | "appDataDir">): {
  args: string[];
  env: Record<string, string>;
} {
  const args = ["acp"];
  if (options.geminiDir) args.push("--gemini-dir", options.geminiDir);
  if (options.appDataDir) args.push("--app-data-dir", options.appDataDir);
  const env = childEnv("agy", options.env ?? process.env);
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "1";
  if (options.geminiDir) env.GEMINI_HOME = options.geminiDir;
  const browser = agyBrowserCommand();
  if (browser) env.BROWSER = browser;
  return { args, env };
}

/** The sign-in link in a line agy printed, when it is one. */
export function agyAuthLink(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith(AUTH_LINK_PREFIX)) return trimmed.slice(AUTH_LINK_PREFIX.length).trim() || undefined;
  const marker = trimmed.indexOf(BROWSER_MARKER);
  if (marker === -1) return undefined;
  try {
    const url: unknown = JSON.parse(trimmed.slice(marker + BROWSER_MARKER.length));
    return typeof url === "string" && url ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a JSON-RPC error means agy needs the user to sign in. */
export function isAgyAuthError(error: unknown): error is Error & { code: number } {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === -32000 || (code === -32603 && error.message.startsWith(NO_BROWSER_PREFIX));
}

/** An agy RPC failure as the session's typed error. */
export function agyRequestError(error: unknown, fallback: string): Error {
  if (error instanceof AgyAuthError || error instanceof AgyTurnError) return error;
  if (isAgyAuthError(error)) {
    const data = (error as Error & { data?: unknown }).data;
    return new AgyAuthError(error.message || "agy needs you to sign in", {
      code: error.code,
      ...(data !== undefined ? { data } : {}),
    });
  }
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "number" || typeof code === "string") {
      return new AgyTurnError(error.message || fallback, { code, cause: error });
    }
    return error;
  }
  return new AgyTurnError(fallback, { cause: error });
}

function parseVersion(value: string | undefined): [number, number, number] | undefined {
  const match = value ? /(\d+)\.(\d+)\.(\d+)/.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function olderThan(version: [number, number, number], minimum: readonly [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (version[index]! !== minimum[index]!) return version[index]! < minimum[index]!;
  }
  return false;
}

/** Spawn `agy acp`, initialize it and sign in. Any failure closes the process. */
export async function startAgyAcp(options: StartAgyAcpOptions): Promise<StartedAgyAcp> {
  const launch = agyAcpLaunch(options);
  const { client, whenExited } = startJsonRpcProcess({
    cli: "agy",
    label: "agy acp",
    spawnFn: options.spawnFn ?? nodeSpawn,
    command: options.executablePath || "agy",
    args: launch.args,
    cwd: options.cwd,
    env: launch.env,
    jsonrpcField: true,
  });

  // A signed-out agy prints its sign-in link instead of answering; the
  // handshake then fails with that link rather than waiting out a timeout.
  let rejectSignIn: ((error: Error) => void) | undefined;
  const signInNeeded = new Promise<never>((_resolve, reject) => {
    rejectSignIn = reject;
  });
  signInNeeded.catch(() => {});
  const onLine = (line: string): void => {
    const url = agyAuthLink(line);
    if (url) rejectSignIn?.(new AgyAuthError("agy needs you to sign in: run `agy` or `agy acp --login`", { url }));
  };
  const disposeStdout = client.onStdoutNonJson(onLine);
  let stderrLine = "";
  const disposeStderr = client.onStderr((chunk) => {
    stderrLine += chunk;
    const lines = stderrLine.split("\n");
    stderrLine = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  });

  const abort = () => client.close();
  options.signal?.addEventListener("abort", abort, { once: true });
  const step = <T>(request: Promise<T>, ms: number, label: string): Promise<T> =>
    raceTimeout([request, signInNeeded], ms, () => new AgyTurnError(`agy acp ${label} timed out`, { code: "timeout" }));
  try {
    if (options.signal?.aborted) throw new AbortError();
    const initialized = await step(client.request("initialize", {
      protocolVersion: 2,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        session: { notices: {}, compaction: {} },
      },
      clientInfo: CLIENT_INFO,
    }, null), INITIALIZE_TIMEOUT_MS, "initialize");
    const result = isRecord(initialized) ? initialized : {};
    const protocolVersion = typeof result.protocolVersion === "number" ? result.protocolVersion : 0;
    if (protocolVersion !== 1 && protocolVersion !== 2) {
      throw new AgyTurnError(`agy acp speaks ACP protocol ${protocolVersion}, not 1 or 2`, {
        kind: "unsupported",
        code: "unsupported_protocol",
      });
    }
    const agentInfo = isRecord(result.agentInfo) ? result.agentInfo : {};
    const agentVersion = typeof agentInfo.version === "string" ? agentInfo.version : undefined;
    const parsed = parseVersion(agentVersion);
    if (parsed && olderThan(parsed, MIN_AGY_VERSION)) {
      throw new AgyTurnError(`agy ${agentVersion} is too old: this library needs agy 1.5.0 or newer`, {
        kind: "unsupported",
        code: "unsupported_version",
      });
    }
    await step(
      client.request("authenticate", { methodId: options.authMethod ?? "oauth-personal" }, null),
      AUTHENTICATE_TIMEOUT_MS,
      "authenticate",
    );
    return {
      client,
      whenExited,
      agent: {
        ...(agentVersion ? { version: agentVersion } : {}),
        protocolVersion,
        capabilities: isRecord(result.agentCapabilities) ? result.agentCapabilities : {},
      },
    };
  } catch (error) {
    client.close();
    if (options.signal?.aborted) throw new AbortError();
    throw agyRequestError(error, "agy acp failed to start");
  } finally {
    options.signal?.removeEventListener("abort", abort);
    disposeStdout();
    disposeStderr();
  }
}
