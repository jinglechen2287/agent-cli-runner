/**
 * Provider-normalized token accounting, so a host can render one context-usage
 * meter for both Claude and Codex without knowing either CLI's raw shape.
 */

/**
 * Normalized token counts for the turn. `contextTokens` comes from the latest
 * provider request rather than cumulative turn totals, so it can drive a
 * current context-window meter for both Claude and Codex.
 */
export interface TokenUsage {
  /**
   * Tokens occupying the model's context window: fresh input plus cached
   * input. The headline "how full is the context" number.
   */
  contextTokens: number;
  /** Fresh (non-cached) input tokens. */
  inputTokens: number;
  /** Input tokens served from cache (Claude cache reads; Codex cached input). */
  cachedInputTokens: number;
  /**
   * Provider-reported output tokens. Codex includes its separately reported
   * reasoning-token subset in this count.
   */
  outputTokens: number;
  /**
   * Model that produced this usage, when the CLI reports it. Claude reports it
   * on every turn; Codex `exec` does not, so this is only present when the host
   * told the runner which model it launched.
   */
  model?: string;
  /**
   * The model's total context window in tokens, when known — reported by the
   * provider or resolved from the model id via {@link contextWindowForModel}.
   * Absent when neither source could supply it; render the raw token count
   * without a percentage in that case.
   */
  contextWindow?: number;
}

/**
 * Context-window sizes for models whose id doesn't follow a simple family rule.
 * Values are best-effort fallbacks for callers without a provider-reported
 * window; `runCodex` prefers app-server's authoritative effective window.
 * Anthropic models are handled by {@link CLAUDE_CONTEXT_WINDOWS} instead.
 */
export const KNOWN_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "gpt-5.2": 272_000,
  "gpt-5.4": 272_000,
  "gpt-5.4-mini": 272_000,
  "gpt-5.5": 272_000,
  "gpt-5.6-luna": 372_000,
  "gpt-5.6-sol": 372_000,
  "gpt-5.6-terra": 372_000,
  "codex-auto-review": 272_000,
};

const CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000;
const CLAUDE_1M_CONTEXT_WINDOW = 1_000_000;

/**
 * The window Claude Code runs each Claude model at by default, keyed by
 * canonical id — the value it later reports in a turn's `modelUsage`. Copied
 * from Claude Code 2.1.312's built-in model registry; to re-check after a CLI
 * update, search the binary's strings for `context:{window:`. Claude Code also
 * honors a `[1m]` marker on any model, handled before this table.
 */
export const CLAUDE_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "claude-opus-4": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-opus-4-0": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-opus-4-1": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-opus-4-5": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-opus-4-6": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-opus-4-7": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-opus-4-8": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-opus-5": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-opus-5-5": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-sonnet-4": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-sonnet-4-0": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-sonnet-4-5": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-sonnet-4-6": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-sonnet-5": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-sonnet-5-5": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-haiku-4-5": CLAUDE_DEFAULT_CONTEXT_WINDOW,
  "claude-haiku-5-5": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-fable-5": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-fable-5-1": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-mythos-5": CLAUDE_1M_CONTEXT_WINDOW,
  "claude-mythos-5-1": CLAUDE_1M_CONTEXT_WINDOW,
};

/** Family and version inside any spelling of a Claude id: dated
 * (`-20251101`), Bedrock (`us.anthropic.…-v1:0`) or Vertex (`@20251101`). A
 * minor version is one or two digits, so a date is never read as one. */
const CLAUDE_MODEL_ID = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/;

function claudeContextWindow(id: string): number {
  if (/\[1m\]|[-_]1m\b/.test(id)) return CLAUDE_1M_CONTEXT_WINDOW;
  const match = CLAUDE_MODEL_ID.exec(id);
  if (!match) {
    // Fable and Mythos ship only at 1M, unversioned previews included.
    return /fable|mythos/.test(id) ? CLAUDE_1M_CONTEXT_WINDOW : CLAUDE_DEFAULT_CONTEXT_WINDOW;
  }
  const [, family, major, minor] = match;
  const canonical = `claude-${family}-${major}${minor !== undefined ? `-${minor}` : ""}`;
  if (Object.prototype.hasOwnProperty.call(CLAUDE_CONTEXT_WINDOWS, canonical)) {
    return CLAUDE_CONTEXT_WINDOWS[canonical]!;
  }
  // A model newer than the table: a best-effort guess. Fable and Mythos ship
  // only at 1M, and every Claude 5 model is natively 1M; the turn's result
  // reports the real window either way.
  if (family === "fable" || family === "mythos") return CLAUDE_1M_CONTEXT_WINDOW;
  return Number(major) >= 5 ? CLAUDE_1M_CONTEXT_WINDOW : CLAUDE_DEFAULT_CONTEXT_WINDOW;
}

/**
 * Best-effort context window (in tokens) for a model id, or `undefined` when it
 * can't be determined. Consults {@link KNOWN_CONTEXT_WINDOWS} first. Claude ids
 * resolve through {@link CLAUDE_CONTEXT_WINDOWS} (1M for any `[1m]` variant,
 * and a generation guess for models newer than the table); Codex `gpt-5.6*` /
 * other `gpt-5*` models get 372k / 272k.
 */
export function contextWindowForModel(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const id = model.trim().toLowerCase();
  if (!id) return undefined;
  if (Object.prototype.hasOwnProperty.call(KNOWN_CONTEXT_WINDOWS, id)) {
    return KNOWN_CONTEXT_WINDOWS[id];
  }
  if (id.includes("claude")) return claudeContextWindow(id);
  if (id.startsWith("gpt-5.6")) return 372_000;
  if (id.startsWith("gpt-5")) return 272_000;
  return undefined;
}
