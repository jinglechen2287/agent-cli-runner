import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { AbortError, TimeoutError } from "./errors.js";

export const SIGTERM_GRACE_MS = 2000;

/** Collapse a raw tool field into the one-line, non-empty form promised by a
 * tool-use summary. Runs of whitespace (including newlines in a multiline
 * command) become single spaces; an empty or whitespace-only value yields
 * undefined so callers can omit the summary entirely. */
export function normalizeSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const summary = value.replace(/\s+/g, " ").trim();
  return summary || undefined;
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

export function isMissingExecutable(error: Error): boolean {
  return "code" in error && (error as Error & { code?: unknown }).code === "ENOENT";
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

export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
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
        child.kill(signal);
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
    child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}
