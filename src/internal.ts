import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, resolve as resolvePath, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { AbortError, TimeoutError } from "./errors.js";
import type { AgentCallbacks, McpElicitationRequest, McpElicitationResponse } from "./types.js";

export const SIGTERM_GRACE_MS = 2000;

/** Asks a turn's callback for an MCP server's answer. Always settles: no
 * callback declines, a throw or any of `signals` firing cancels, and a late
 * answer from the callback is ignored. */
export function answerMcpElicitation(
  callback: AgentCallbacks["onMcpElicitation"],
  request: McpElicitationRequest,
  signals: readonly AbortSignal[],
): Promise<McpElicitationResponse> {
  if (!callback) return Promise.resolve({ action: "decline" });
  const controller = new AbortController();
  const fire = (): void => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) return Promise.resolve({ action: "cancel" });
    signal.addEventListener("abort", fire, { once: true });
  }
  return new Promise<McpElicitationResponse>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve({ action: "cancel" }), { once: true });
    Promise.resolve()
      .then(() => callback(request, { signal: controller.signal }))
      .then(resolve, () => resolve({ action: "cancel" }));
  }).finally(() => {
    for (const signal of signals) signal.removeEventListener("abort", fire);
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Run a host callback without letting an exception escape into the provider
 * stream: a throwing callback must never crash the process, drop the rest of
 * a stdout chunk, or leave the run promise unsettled. An async callback's
 * rejection is swallowed too — an unhandled rejection would otherwise bring
 * down the process just like a synchronous throw. */
export function safeCallback(use: () => unknown): void {
  try {
    const result = use();
    if (
      result !== null
      && typeof result === "object"
      && typeof (result as PromiseLike<unknown>).then === "function"
    ) {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Host callbacks must never corrupt the provider stream.
  }
}

/** "N/M steps completed" — the one plan summary both providers report, kept
 * here so the cross-provider wording can never drift. */
export function planCompletionSummary(planItems: readonly { status: string }[]): string {
  const completed = planItems.filter((item) => item.status === "completed").length;
  return `${completed}/${planItems.length} steps completed`;
}

/** Normalize a provider plan/todo status into snake_case: camelCase
 * ("inProgress") and spaced ("in progress") forms both become "in_progress". */
export function normalizePlanStatus(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const status = value.trim();
  if (!status) return undefined;
  return status.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/\s+/g, "_");
}

/** Collapse a raw tool field into the one-line, non-empty form promised by a
 * tool-use summary. Runs of whitespace (including newlines in a multiline
 * command) become single spaces; an empty or whitespace-only value yields
 * undefined so callers can omit the summary entirely. */
export function normalizeSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const summary = value.replace(/\s+/g, " ").trim();
  return summary || undefined;
}

/** Coerce a CLI-reported token count into a non-negative integer, defaulting
 * to 0 for missing, negative, or non-finite values. */
export function toTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

/** Coerce a CLI-reported context-window size into a positive integer, or
 * undefined when missing or malformed — callers fall back to the model-id
 * family rules instead of trusting a bogus wire value. */
export function toContextWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function filterEnv(
  base: NodeJS.ProcessEnv,
  stripped: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  // Windows environment variable names are case-insensitive.
  const normalize = (key: string): string =>
    process.platform === "win32" ? key.toUpperCase() : key;
  const strippedKeys = new Set(stripped.map(normalize));
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !strippedKeys.has(normalize(key))) env[key] = value;
  }
  return env;
}

export function isMissingExecutable(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as Error & { code?: unknown }).code === "ENOENT";
}

/** Buffers stdout chunks and emits complete newline-terminated lines. */
export function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: Buffer | string): void;
  flush(): void;
} {
  let buffer = "";
  // A chunk boundary can fall inside a multibyte UTF-8 sequence; the decoder
  // holds the partial bytes until the rest arrives.
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk: Buffer | string): void {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        onLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },
    flush(): void {
      buffer += decoder.end();
      if (buffer) onLine(buffer);
      buffer = "";
    },
  };
}

/** Decodes stderr (or any text stream) chunk-by-chunk without corrupting a
 * multibyte UTF-8 character split across a chunk boundary — the same
 * StringDecoder treatment stdout gets from {@link createLineSplitter}. */
export function createChunkDecoder(onText: (text: string) => void): {
  push(chunk: Buffer | string): void;
  flush(): void;
} {
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk: Buffer | string): void {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (text) onText(text);
    },
    flush(): void {
      const rest = decoder.end();
      if (rest) onText(rest);
    },
  };
}

/** Sends the prompt on stdin and closes it, so it never appears in argv. */
export function writePrompt(child: ChildProcess, prompt: string): void {
  const stdin = child.stdin;
  if (!stdin) return;
  // EPIPE arrives when the child exits before draining stdin; the close
  // handler already reports that outcome.
  stdin.on("error", () => {});
  stdin.end(prompt);
}

export interface LifecycleOptions {
  /** Used in AbortError/TimeoutError messages, e.g. "claude". */
  cli: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  kill: (signal: NodeJS.Signals) => void;
}

export interface Lifecycle {
  /** Error to reject with once the child closes, or null for a normal exit. */
  interruptionError(): Error | null;
  cleanup(): void;
}

/** Wires abort/timeout to a SIGTERM → grace period → SIGKILL escalation. */
export function watchLifecycle(opts: LifecycleOptions): Lifecycle {
  let aborted = false;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  const terminate = (): void => {
    opts.kill("SIGTERM");
    killTimer ??= setTimeout(() => opts.kill("SIGKILL"), SIGTERM_GRACE_MS);
  };

  const abortHandler = (): void => {
    if (aborted || timedOut) return;
    aborted = true;
    terminate();
  };

  if (opts.signal) {
    if (opts.signal.aborted) abortHandler();
    else opts.signal.addEventListener("abort", abortHandler, { once: true });
  }

  if (opts.timeoutMs !== undefined) {
    timeoutTimer = setTimeout(() => {
      if (aborted || timedOut) return;
      timedOut = true;
      terminate();
    }, opts.timeoutMs);
  }

  return {
    interruptionError(): Error | null {
      if (aborted) return new AbortError(`${opts.cli} run aborted`);
      if (timedOut) {
        return new TimeoutError(`${opts.cli} run timed out after ${opts.timeoutMs}ms`);
      }
      return null;
    },
    cleanup(): void {
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      opts.signal?.removeEventListener("abort", abortHandler);
    },
  };
}

export function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  killDirect: (signal: NodeJS.Signals) => void = (direct) => child.kill(direct),
): void {
  if (child.pid && process.platform !== "win32") {
    try {
      // Codex is spawned as a detached process-group leader. Signaling the
      // negative pid reaches its shell/tool descendants as well.
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if the group is already unavailable.
    }
  }
  if (child.pid && process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    const killer = nodeSpawn("taskkill", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    let fellBack = false;
    const fallback = (): void => {
      if (fellBack) return;
      fellBack = true;
      try {
        killDirect(signal);
      } catch {
        // The process may already have exited.
      }
    };
    killer.once("error", fallback);
    killer.once("exit", (code) => {
      if (code !== 0) fallback();
    });
    return;
  }
  try {
    killDirect(signal);
  } catch {
    // The process may already have exited.
  }
}

/** On Windows, route `child.kill` through a forced {@link signalProcessTree},
 * so the kills `execFile` makes itself (timeout, maxBuffer) reach the whole
 * tree: a batch launch's real program is cmd.exe's child, which a plain kill
 * of cmd.exe leaves running. Always forced, whatever signal execFile names —
 * it never escalates, and a console program can refuse an unforced taskkill.
 * The tree kill leaves an exit code behind, so a caller must check `killed`
 * before treating a numeric code as an exit. Elsewhere `execFile` children
 * share our process group, so this is a no-op. */
export function killTreeOnKill(child: ChildProcess): void {
  if (process.platform !== "win32") return;
  const killDirect = child.kill.bind(child);
  child.kill = (): boolean => {
    signalProcessTree(child, "SIGKILL", (signal) => {
      killDirect(signal);
    });
    return true;
  };
}

/** Resolve a CLI name to an absolute path through `env.PATH`, the way a shell
 * would; a name that already contains a path separator is checked in place.
 * Returns undefined when nothing executable is found. */
export interface ResolveExecutableOptions {
  /** The child's working directory: relative names and PATH entries resolve
   * against it, as spawn would resolve them. Defaults to `process.cwd()`. */
  cwd?: string | undefined;
  platform?: NodeJS.Platform;
}

export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  { cwd = process.cwd(), platform = process.platform }: ResolveExecutableOptions = {},
): string | undefined {
  if (platform === "win32") return resolveWindowsExecutable(name, env, cwd);
  const isExecutable = (candidate: string): boolean => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  if (name.includes("/")) {
    const candidate = resolvePath(cwd, name);
    return isExecutable(candidate) ? candidate : undefined;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = resolvePath(cwd, dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** Windows env names are case-insensitive, but a plain env object (unlike
 * `process.env` there) keeps whatever case it was built with — `Path` is common. */
function windowsEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper && value !== undefined) return value;
  }
  return undefined;
}

/** Windows lookup: a file is runnable by its extension, so a bare name is
 * tried with each PATHEXT extension — never alone, which would pick the
 * extensionless shell script npm installs beside its `.cmd` shim. A name
 * that already has an extension is tried as it is first. */
function resolveWindowsExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string | undefined {
  const extensions = (windowsEnvValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  const candidates = (base: string): string[] => [
    ...(extname(base) ? [base] : []),
    ...extensions.map((extension) => base + extension),
  ];
  const isFile = (candidate: string): boolean => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  if (/[\\/]/.test(name)) return candidates(resolvePath(cwd, name)).find(isFile);
  // Windows accepts quoted entries (`"C:\Program Files\x"`); a path itself
  // cannot contain a quote.
  for (const entry of (windowsEnvValue(env, "PATH") ?? "").split(win32.delimiter)) {
    const dir = entry.replace(/"/g, "");
    if (!dir) continue;
    const found = candidates(resolvePath(cwd, dir, name)).find(isFile);
    if (found) return found;
  }
  return undefined;
}

/** cmd.exe metacharacters, escaped with `^` (the set cross-spawn uses). */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** Quote one argument for the program a batch file runs, then caret-escape
 * it twice: once for the `cmd.exe /c` line, once more for the batch file's
 * own line where its `%*` expands — npm shims forward arguments that way. */
function escapeBatchArgument(arg: string): string {
  const quoted = `"${arg
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META_CHARS, "^$1").replace(CMD_META_CHARS, "^$1");
}

export interface LaunchCommand {
  command: string;
  args: string[];
  options: { windowsVerbatimArguments?: boolean };
}

/** The command line that actually runs `command` with `args`. Off Windows
 * that is the call unchanged. On Windows, spawn finds only `.exe`/`.com`
 * files on PATH and refuses `.cmd`/`.bat` ones outright without a shell,
 * while npm installs CLIs as `.cmd` shims; so the name is resolved through
 * PATHEXT, and a batch file runs under cmd.exe with its arguments escaped
 * to arrive intact. An unresolved name is left for spawn to report missing. */
export function launchCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  { cwd = process.cwd(), platform = process.platform }: ResolveExecutableOptions = {},
): LaunchCommand {
  if (platform !== "win32") return { command, args: [...args], options: {} };
  const resolved = resolveWindowsExecutable(command, env, cwd) ?? command;
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args: [...args], options: {} };
  if (args.some((arg) => /[\r\n]/.test(arg))) {
    throw new Error(`cmd.exe cannot pass a line break in an argument to ${resolved}`);
  }
  const line = [
    win32.normalize(resolved).replace(CMD_META_CHARS, "^$1"),
    ...args.map(escapeBatchArgument),
  ].join(" ");
  return {
    command: windowsEnvValue(env, "ComSpec") ?? windowsEnvValue(process.env, "ComSpec") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}
