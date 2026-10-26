import {
  createClaudeSession,
  type ClaudeHooks,
  type ClaudePermissionMode,
  type ClaudeQueryFn,
} from "./claude-session.js";
import { AbortError } from "./errors.js";
import type { CommonRunOptions, RunResult } from "./types.js";

export { CLAUDE_STRIPPED_ENV_VARS } from "./claude-session.js";
export type { ClaudePermissionMode } from "./claude-session.js";

export interface RunClaudeOptions extends CommonRunOptions {
  /** Model: an alias for the latest of a family ("fable", "opus", "sonnet",
   * "haiku") or a full id ("claude-fable-5"). Omitted = the CLI's configured
   * default. */
  model?: string;
  /** Effort level ("low" | "medium" | "high" | "xhigh" | "max"). Omitted =
   * the CLI's default for the session's model. */
  effort?: string;
  /** Text appended to the Claude Code system prompt. The system prompt is
   * rebuilt on each run, so this must be supplied on resumed turns too. */
  appendSystemPrompt?: string;
  /** Permission mode for the run. `plan` keeps the turn read-only on the
   * project while research tools still run. */
  permissionMode?: ClaudePermissionMode;
  /** Tool names removed from the model's context. */
  disallowedTools?: string[];
  /** Built-in tools: `["default"]` is the full Claude Code set. An explicit
   * empty array disables every built-in rather than being omitted, so an
   * empty whitelist can never silently widen back to the full set. MCP tools
   * are outside this option's scope; gate those with hooks or settings. */
  tools?: string[];
  /** Tools pre-approved without a permission check. Auto-allow only: this
   * never restricts the tool set. */
  allowedTools?: string[];
  /** Settings sources the CLI may load ("user", "project", "local").
   * Omitted = all of them. Omitting a source drops its permission rules for
   * the turn — e.g. excluding "user" keeps a broad `permissions.allow` in
   * ~/.claude/settings.json from pre-approving what the turn's permission
   * mode would otherwise gate. */
  settingSources?: Array<"user" | "project" | "local">;
  /** Extra flag settings: a JSON string, a file path, or an object. Merged
   * on top of the loaded setting sources. */
  settings?: string | Record<string, unknown>;
  /** In-process hook callbacks (e.g. a PreToolUse guard). A callback that
   * throws counts as no opinion, so a guard must catch its own errors. */
  hooks?: ClaudeHooks;
  /** Pre-assign a UUID for the new session (turn 1). Mutually exclusive with resumeSessionId. */
  newSessionId?: string;
  /** Resume an existing session by id (turn 2+). Mutually exclusive with newSessionId. */
  resumeSessionId?: string;
  /** Run a non-persistent one-shot request with customizations, tools, and MCP
   * disabled. Intended for small metadata tasks such as chat titles. */
  isolated?: boolean;
  /** Test seam: replaces the Agent SDK's `query()`. */
  queryFn?: ClaudeQueryFn;
}

/** Run one Claude Code turn through the Agent SDK: start a session, run the
 * turn, and close the session. Hosts that keep a conversation going should
 * hold a {@link createClaudeSession} session instead, which keeps the CLI up
 * between turns. */
export async function runClaude(opts: RunClaudeOptions): Promise<RunResult> {
  const {
    prompt,
    signal,
    timeoutMs,
    cwd,
    executablePath,
    env,
    spawnFn,
    queryFn,
    model,
    effort,
    appendSystemPrompt,
    permissionMode,
    disallowedTools,
    tools,
    allowedTools,
    settingSources,
    settings,
    hooks,
    newSessionId,
    resumeSessionId,
    isolated,
    ...callbacks
  } = opts;
  // Checked before the session exists, so an aborted run never spawns.
  if (signal?.aborted) throw new AbortError("claude run aborted");
  const session = await createClaudeSession({
    cwd,
    ...(executablePath !== undefined ? { executablePath } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(spawnFn !== undefined ? { spawnFn } : {}),
    ...(queryFn !== undefined ? { queryFn } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(settingSources !== undefined ? { settingSources } : {}),
    ...(settings !== undefined ? { settings } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
    ...(newSessionId !== undefined ? { newSessionId } : {}),
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    ...(isolated !== undefined ? { isolated } : {}),
  });
  try {
    return await session.runTurn({
      prompt,
      ...(signal !== undefined ? { signal } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...callbacks,
    });
  } finally {
    await session.close();
  }
}
