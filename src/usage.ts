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
 * Anthropic models are handled by the family rules in
 * {@link contextWindowForModel} instead.
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
 * Best-effort context window (in tokens) for a model id, or `undefined` when it
 * can't be determined. Consults {@link KNOWN_CONTEXT_WINDOWS} first, then
 * falls back to family rules: Anthropic models get 200k (1M for the `[1m]`
 * beta variants), and Codex `gpt-5.6*` / other `gpt-5*` models get 372k / 272k.
 */
export function contextWindowForModel(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const id = model.trim().toLowerCase();
  if (!id) return undefined;
  if (Object.prototype.hasOwnProperty.call(KNOWN_CONTEXT_WINDOWS, id)) {
    return KNOWN_CONTEXT_WINDOWS[id];
  }
  if (id.includes("claude")) {
    return /\[1m\]|[-_]1m\b/.test(id)
      ? CLAUDE_1M_CONTEXT_WINDOW
      : CLAUDE_DEFAULT_CONTEXT_WINDOW;
  }
  if (id.startsWith("gpt-5.6")) return 372_000;
  if (id.startsWith("gpt-5")) return 272_000;
  return undefined;
}
