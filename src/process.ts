/**
 * Child-process plumbing shared by every runner: finding a CLI, launching it
 * (through cmd.exe for a Windows batch shim), reading its output, and
 * stopping its whole process tree.
 */
import { execFile, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, resolve as resolvePath, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { MissingCliError, runAborted, runTimedOut } from "./errors.js";
import { createDeferred, type Deferred } from "./internal.js";
import type { AgentProvider } from "./providers.js";
import type { SpawnFn } from "./types.js";

export const SIGTERM_GRACE_MS = 2000;

/** Nesting-guard variables the Claude CLI uses to refuse running inside
 * another Claude Code session. Stripped so hosts launched by Claude Code
 * (or exposing it, like a bot) can still spawn turns. */
export const CLAUDE_STRIPPED_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
] as const;

/** Stripped so a Codex turn spawned from within another Codex session does
 * not inherit the parent's thread. */
export const CODEX_STRIPPED_ENV_VARS = ["CODEX_THREAD_ID"] as const;

/** agy sets this inside its own tool shells; stripped so an agy session
 * started from within another agy session does not inherit its conversation. */
export const AGY_STRIPPED_ENV_VARS = ["ANTIGRAVITY_CONVERSATION_ID"] as const;

function strippedEnvVars(cli: AgentProvider): readonly string[] {
  switch (cli) {
    case "claude":
      return CLAUDE_STRIPPED_ENV_VARS;
    case "codex":
      return CODEX_STRIPPED_ENV_VARS;
    case "agy":
      return AGY_STRIPPED_ENV_VARS;
  }
}

function filterEnv(
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

/** The environment for a CLI child: `base` without that CLI's nesting guards. */
export function childEnv(
  cli: AgentProvider,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return filterEnv(base, strippedEnvVars(cli));
}

export function isMissingExecutable(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as Error & { code?: unknown }).code === "ENOENT";
}

export interface SpawnCliOptions {
  /** Names the CLI in a MissingCliError. */
  cli: AgentProvider;
  spawnFn: SpawnFn;
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Spawn a CLI with piped stdio through {@link launchCommand}. Off Windows it
 * leads its own process group, so stopping it reaches the shells and tools it
 * started as well. A spawn that throws ENOENT becomes a MissingCliError. */
export function spawnCli(options: SpawnCliOptions): ChildProcess {
  try {
    const launch = launchCommand(options.command, options.args, options.env, { cwd: options.cwd });
    return options.spawnFn(launch.command, launch.args, {
      ...launch.options,
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  } catch (error) {
    if (isMissingExecutable(error)) throw new MissingCliError(options.cli);
    throw error;
  }
}

export interface ExecCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecCliOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs: number;
}

/** Run a CLI to completion. Resolves with any exit code; rejects when it
 * could not start, outgrew the output buffer, or ran past its timeout,
 * carrying whatever it printed first as `stdout` and `stderr` on the error
 * (and `killed: true` for a timeout).
 *
 * At the timeout a POSIX CLI gets SIGTERM, so it can stop what it started,
 * then SIGKILL after the grace period, so one that traps SIGTERM cannot keep
 * the promise pending. Should something it started still hold its output
 * pipes a grace period after that, they are closed and the run settles with
 * what it printed. On Windows the deadline force-kills the tree at once (see
 * {@link killTreeOnKill}). Outgrowing the buffer is a SIGKILL straight away. */
export function execCli(
  executable: string,
  args: readonly string[],
  options: ExecCliOptions,
): Promise<ExecCliResult> {
  return new Promise((resolve, reject) => {
    const launch = launchCommand(executable, args, options.env, { cwd: options.cwd });
    const exited = createDeferred();
    let timedOut = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(
      launch.command,
      launch.args,
      {
        ...launch.options,
        cwd: options.cwd,
        env: options.env,
        maxBuffer: 1_000_000,
        // Only execFile's own kill, for outgrowing maxBuffer: the deadline
        // below stops the CLI itself.
        killSignal: "SIGKILL",
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        exited.resolve();
        clearTimeout(deadline);
        // Past its deadline the run failed, however the CLI then exited: one
        // that handles SIGTERM may well exit 0.
        if (timedOut) {
          reject(Object.assign(error ?? new Error(`${executable} timed out`), {
            killed: true,
            stdout,
            stderr,
          }));
          return;
        }
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        // `killed` first: a Windows tree kill (timeout, maxBuffer) leaves an
        // exit code that is not the command's own.
        if (typeof error.code === "number" && !error.killed) {
          resolve({ stdout, stderr, exitCode: error.code });
          return;
        }
        // A kill leaves no exit status, but the callback still hands over
        // what the child printed first: keep it on the error.
        reject(Object.assign(error, { stdout, stderr }));
      },
    );
    killTreeOnKill(child);
    deadline = setTimeout(() => {
      timedOut = true;
      void terminateTree((signal) => {
        child.kill(signal);
      }, exited).then(() => {
        if (exited.settled) return;
        child.stdout?.destroy();
        child.stderr?.destroy();
      });
    }, options.timeoutMs);
  });
}

/** Buffers stdout chunks and emits complete newline-terminated lines. */
export function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: Buffer | string): void;
  flush(): void;
} {
  let buffer = "";
  /** A drain is reading `buffer`: text that arrives meanwhile (an onLine that
   * makes the child write) joins the scan already under way. */
  let draining = false;
  const decoder = createChunkDecoder((text) => {
    buffer += text;
    if (draining) return;
    draining = true;
    let start = 0;
    try {
      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n", start)) {
        onLine(buffer.slice(start, newline));
        // Only past a line once onLine has returned: one that throws stays
        // buffered.
        start = newline + 1;
      }
    } finally {
      draining = false;
      if (start > 0) buffer = buffer.slice(start);
    }
  });
  return {
    push: decoder.push,
    flush(): void {
      decoder.flush();
      if (buffer) onLine(buffer);
      buffer = "";
    },
  };
}

/** Decodes stderr (or any text stream) chunk-by-chunk without corrupting a
 * multibyte UTF-8 character split across a chunk boundary: the decoder holds
 * the partial bytes until the rest arrives. */
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

/** SIGTERM the process now, SIGKILL it after `graceMs`, and resolve once it
 * has exited, or `graceMs` after the SIGKILL, so a process that ignores even
 * that (a zombie the OS has not reaped) cannot hang the caller. An exit seen
 * before the SIGKILL timer fires stops it, even one in the same tick. */
export function terminateTree(
  kill: (signal: NodeJS.Signals) => void,
  exited: Pick<Deferred<void>, "promise" | "settled">,
  { graceMs = SIGTERM_GRACE_MS, unref = false }: { graceMs?: number; unref?: boolean } = {},
): Promise<void> {
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
  const send = (signal: NodeJS.Signals): void => {
    try {
      kill(signal);
    } catch {
      // The process may be gone already; its exit, or the give-up, settles this.
    }
  };
  const gaveUp = new Promise<void>((resolve) => {
    send("SIGTERM");
    killTimer = setTimeout(() => {
      if (exited.settled) return;
      send("SIGKILL");
      giveUpTimer = setTimeout(resolve, graceMs);
      if (unref) giveUpTimer.unref?.();
    }, graceMs);
    if (unref) killTimer.unref?.();
  });
  const stopped = Promise.race([exited.promise, gaveUp]);
  const clear = (): void => {
    clearTimeout(killTimer);
    clearTimeout(giveUpTimer);
  };
  stopped.then(clear, clear);
  return stopped;
}

export interface LifecycleOptions {
  /** Used in AbortError/TimeoutError messages, e.g. "claude". */
  cli: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** Stops the process: called once, on the abort or the timeout. */
  terminate: () => void;
}

export interface Lifecycle {
  /** Error to reject with once the child closes, or null for a normal exit. */
  interruptionError(): Error | null;
  cleanup(): void;
}

/** Wires an abort signal and a timeout to one call of `terminate`. */
export function watchLifecycle(opts: LifecycleOptions): Lifecycle {
  let aborted = false;
  let timedOut = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  const abortHandler = (): void => {
    if (aborted || timedOut) return;
    aborted = true;
    opts.terminate();
  };

  if (opts.signal) {
    if (opts.signal.aborted) abortHandler();
    else opts.signal.addEventListener("abort", abortHandler, { once: true });
  }

  if (opts.timeoutMs !== undefined) {
    timeoutTimer = setTimeout(() => {
      if (aborted || timedOut) return;
      timedOut = true;
      opts.terminate();
    }, opts.timeoutMs);
  }

  return {
    interruptionError(): Error | null {
      if (aborted) return runAborted(opts.cli);
      if (timedOut) return runTimedOut(opts.cli, opts.timeoutMs);
      return null;
    },
    cleanup(): void {
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
  const killDirectSafely = (): void => {
    try {
      killDirect(signal);
    } catch {
      // The process may already have exited.
    }
  };
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
      killDirectSafely();
    };
    killer.once("error", fallback);
    killer.once("exit", (code) => {
      if (code !== 0) fallback();
    });
    return;
  }
  killDirectSafely();
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

export interface ResolveExecutableOptions {
  /** The child's working directory: relative names and PATH entries resolve
   * against it, as spawn would resolve them. Defaults to `process.cwd()`. */
  cwd?: string | undefined;
  platform?: NodeJS.Platform;
}

/** Resolve a CLI name to an absolute path through `env.PATH`, the way a shell
 * would; a name that already contains a path separator is checked in place.
 * Returns undefined when nothing executable is found. */
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
