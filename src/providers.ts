/**
 * The providers this library runs, and what it can do with each of them.
 * The capabilities are facts about the CLIs as this library drives them;
 * host policy (which turns a product allows, say) stays with the host.
 */

export type AgentProvider = "claude" | "codex" | "agy";

/** What this library can do with one CLI. */
export interface ProviderCapabilities {
  /** A turn can run on a chosen service tier (`serviceTier`). */
  serviceTiers: boolean;
  /** `compact()` takes focus instructions for the summary. */
  compactionFocus: boolean;
  /** A run can be a throwaway fork of a session (`forkSessionId`). */
  sideFork: boolean;
  /** A session can be copied into a new one that carries on
   * (`forkClaudeSession` / `forkCodexThread`). */
  lastingFork: boolean;
  /** A saved session can be deleted (`deleteClaudeSession`). */
  deleteSession: boolean;
  /** `onMcpStatus` fires (on long-lived sessions). */
  mcpStatus: boolean;
  /** `onMcpElicitation` can be asked. */
  mcpElicitation: boolean;
  /** In-process hooks can guard every tool call before it runs. */
  toolHooks: boolean;
  /** The host answers the CLI's own permission requests per call
   * (`onPermissionRequest`). */
  permissionCallback: boolean;
  /** A turn can be held read-only by the CLI (Codex's read-only sandbox,
   * Claude's plan permission mode). */
  readOnlyTurns: boolean;
  /** Prompts can carry local images (`imagePaths`). */
  images: boolean;
  /** A failed turn rejects with a ProviderTurnError ("rejects") or resolves
   * with exitCode 1 ("resolves"). */
  failedTurn: "rejects" | "resolves";
}

function frozen(capabilities: ProviderCapabilities): Readonly<ProviderCapabilities> {
  return Object.freeze(capabilities);
}

export const PROVIDER_CAPABILITIES: Readonly<Record<AgentProvider, Readonly<ProviderCapabilities>>> =
  Object.freeze({
    claude: frozen({
      serviceTiers: false,
      compactionFocus: true,
      sideFork: true,
      lastingFork: true,
      deleteSession: true,
      mcpStatus: true,
      mcpElicitation: true,
      toolHooks: true,
      permissionCallback: false,
      readOnlyTurns: true,
      images: false,
      failedTurn: "resolves",
    }),
    codex: frozen({
      serviceTiers: true,
      compactionFocus: false,
      sideFork: true,
      lastingFork: true,
      deleteSession: false,
      mcpStatus: true,
      mcpElicitation: true,
      toolHooks: false,
      permissionCallback: false,
      readOnlyTurns: true,
      images: true,
      failedTurn: "rejects",
    }),
    agy: frozen({
      serviceTiers: false,
      compactionFocus: true,
      sideFork: false,
      lastingFork: false,
      deleteSession: false,
      mcpStatus: false,
      mcpElicitation: false,
      toolHooks: false,
      permissionCallback: true,
      readOnlyTurns: false,
      images: true,
      failedTurn: "rejects",
    }),
  });
