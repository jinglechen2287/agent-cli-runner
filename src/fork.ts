/**
 * Lasting forks: a copy of a conversation that a new session carries on
 * from. A run's `forkSessionId` makes a throwaway copy that answers once and
 * keeps nothing; these keep the copy, and run no turn to make it.
 */
import { deleteSession, forkSession } from "@anthropic-ai/claude-agent-sdk";
import { createCodexAppServerClient, threadIdFrom } from "./codex-app-server.js";
import { AbortError, TimeoutError } from "./errors.js";
import type { RunCodexOptions } from "./run-codex.js";

/** Copying a thread is quick; this bounds an app-server that hangs. */
const DEFAULT_FORK_TIMEOUT_MS = 60_000;

/** Copy a Claude Code session under new ids, as a session of its own that
 * `resumeSessionId` continues. `cwd` is the directory the session was kept
 * for. Reads and writes the session files where the CLI keeps them, under
 * this process's `CLAUDE_CONFIG_DIR` (or the default). Answers the copy's id. */
export async function forkClaudeSession(sessionId: string, options: { cwd: string }): Promise<string> {
  const { sessionId: forked } = await forkSession(sessionId, { dir: options.cwd });
  return forked;
}

/** Delete a Claude Code session kept for `cwd` — say, a fork no one took up. */
export async function deleteClaudeSession(sessionId: string, options: { cwd: string }): Promise<void> {
  await deleteSession(sessionId, { dir: options.cwd });
}

export interface ForkCodexThreadOptions {
  /** The thread to copy. */
  threadId: string;
  cwd: string;
  executablePath?: string;
  env?: NodeJS.ProcessEnv;
  /** Bounds the whole fork, the app-server's start included. Default 60 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  spawnFn?: RunCodexOptions["spawnFn"];
}

/** Fork a Codex thread into a new one that is kept, as one `resumeSessionId`
 * continues, through a one-shot app-server that is closed however the fork
 * ends. Answers the new thread's id. */
export async function forkCodexThread(options: ForkCodexThreadOptions): Promise<string> {
  const signal = options.signal;
  if (signal?.aborted) throw new AbortError();
  const timeoutMs = options.timeoutMs ?? DEFAULT_FORK_TIMEOUT_MS;
  // One deadline for starting the app-server and forking together.
  const deadline = Date.now() + timeoutMs;
  const client = await createCodexAppServerClient({
    cwd: options.cwd,
    requestTimeoutMs: timeoutMs,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
    ...(signal ? { signal } : {}),
  });
  const abort = () => client.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new AbortError();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new TimeoutError("Codex fork timed out while the app-server started");
    const forked = await client.request(
      "thread/fork",
      { threadId: options.threadId, cwd: options.cwd, ephemeral: false },
      remaining,
    );
    const id = threadIdFrom(forked);
    if (!id) throw new Error("Codex answered the fork without a thread id");
    return id;
  } catch (error) {
    if (signal?.aborted) throw new AbortError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    client.close();
  }
}
