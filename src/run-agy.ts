import { createAgySession, type AgyTurnOptions, type CreateAgySessionOptions } from "./agy-session.js";
import { runAborted } from "./errors.js";
import { withoutUndefined } from "./internal.js";
import type { CommonRunOptions, RunResult } from "./types.js";

export type RunAgyOptions = CommonRunOptions
  & Omit<CreateAgySessionOptions, "cwd" | "executablePath" | "env" | "spawnFn" | "signal" | "onContinuation">
  & Pick<AgyTurnOptions, "imagePaths" | "onPermissionRequest">;

/** One agy turn: open a session (or resume one), run the prompt, close it. */
export async function runAgy(opts: RunAgyOptions): Promise<RunResult> {
  if (opts.signal?.aborted) throw runAborted("agy");
  const {
    prompt,
    cwd,
    executablePath,
    env,
    signal,
    timeoutMs,
    spawnFn,
    imagePaths,
    onPermissionRequest,
    onSessionId,
    onAssistantText,
    onAssistantTextDelta,
    onToolUse,
    onToolResult,
    onBackgroundAgentUpdate,
    onStderr,
    onUsage,
    onCompaction,
    onMcpStatus,
    onMcpElicitation,
    ...sessionOptions
  } = opts;
  const session = await createAgySession({
    cwd,
    ...sessionOptions,
    ...withoutUndefined({ executablePath, env, spawnFn, signal }),
  });
  try {
    return await session.runTurn({
      prompt,
      ...withoutUndefined({
        imagePaths,
        signal,
        timeoutMs,
        onPermissionRequest,
        onSessionId,
        onAssistantText,
        onAssistantTextDelta,
        onToolUse,
        onToolResult,
        onBackgroundAgentUpdate,
        onStderr,
        onUsage,
        onCompaction,
        onMcpStatus,
        onMcpElicitation,
      }),
    });
  } finally {
    await session.close();
  }
}
