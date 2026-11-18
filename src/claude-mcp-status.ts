/**
 * A Claude session's MCP server status: the snapshot the init line and the
 * SDK's `mcpServerStatus()` report, handed to whichever turn is running.
 */
import type { ClaudeQuery } from "./claude-session.js";
import { isRecord, raceTimeout, safeCallback } from "./internal.js";
import type { AgentCallbacks, McpServerStatusInfo } from "./types.js";

/** How long one `mcpServerStatus` call may take before the last snapshot stands. */
const MCP_STATUS_TIMEOUT_MS = 5_000;
/** How often a turn looks again while a server is still connecting, and for how
 * long: a server that never settles must not poll for the rest of the turn. */
const MCP_STATUS_POLL_MS = 2_000;
export const MCP_STATUS_POLL_LIMIT_MS = 30_000;

const CLAUDE_MCP_STATUSES: Readonly<Record<string, McpServerStatusInfo["status"]>> = {
  pending: "connecting",
  connected: "connected",
  failed: "failed",
  "needs-auth": "needs-auth",
  disabled: "disabled",
};

/** Normalize what the CLI reports. `known` supplies the error for a server that
 * hasn't changed state, since the init line carries none. */
function claudeMcpStatuses(
  servers: readonly unknown[],
  known: readonly McpServerStatusInfo[] = [],
): McpServerStatusInfo[] {
  return servers.flatMap((server) => {
    if (!isRecord(server) || typeof server.name !== "string" || typeof server.status !== "string") {
      return [];
    }
    if (!Object.hasOwn(CLAUDE_MCP_STATUSES, server.status)) return [];
    const status = CLAUDE_MCP_STATUSES[server.status];
    if (!status) return [];
    const stated = typeof server.error === "string" && server.error ? server.error : undefined;
    const previous = known.find((entry) => entry.name === server.name && entry.status === status);
    const error = stated ?? previous?.error;
    return [{ name: server.name, status, ...(error ? { error } : {}) }];
  });
}

/** What the status reads from the turn it reports to. */
export interface McpStatusTurn {
  callbacks: AgentCallbacks;
  /** When this turn stops looking again for a server still connecting. */
  mcpPollDeadline: number;
}

export interface ClaudeMcpStatus {
  /** The init line's server list: the snapshot changes, then the SDK is asked. */
  fromInit(servers: readonly unknown[]): void;
  /** A turn started: it gets the last snapshot, if there is one yet (an empty
   * list counts), and the SDK is asked again. */
  turnStarted(): void;
  stopPoll(): void;
}

/** The last status seen is kept for the next turn: the process may not repeat
 * its init line, and a server's error comes from `mcpServerStatus` alone.
 * `activeTurn` must hand back the running turn's own object, the same one each
 * time, since a status call that outlives its turn is told apart by identity. */
export function createClaudeMcpStatus(
  runtime: Pick<ClaudeQuery, "mcpServerStatus">,
  activeTurn: () => McpStatusTurn | undefined,
): ClaudeMcpStatus {
  let mcpStatuses: McpServerStatusInfo[] | undefined;
  let mcpStatusInFlight = false;
  let mcpPollTimer: ReturnType<typeof setTimeout> | undefined;

  const emitMcpStatus = (): void => {
    const callbacks = activeTurn()?.callbacks;
    const snapshot = mcpStatuses;
    if (!callbacks?.onMcpStatus || !snapshot) return;
    safeCallback(() => callbacks.onMcpStatus?.(snapshot.map((status) => ({ ...status }))));
  };
  const updateMcpStatus = (next: McpServerStatusInfo[]): void => {
    if (JSON.stringify(next) === JSON.stringify(mcpStatuses)) return;
    mcpStatuses = next;
    emitMcpStatus();
  };
  const stopPoll = (): void => {
    if (mcpPollTimer) clearTimeout(mcpPollTimer);
    mcpPollTimer = undefined;
  };
  /** Best effort: a call that fails or stalls leaves the snapshot as it was. */
  const refreshMcpStatus = async (): Promise<void> => {
    const turn = activeTurn();
    if (!turn?.callbacks.onMcpStatus || !runtime.mcpServerStatus || mcpStatusInFlight) return;
    mcpStatusInFlight = true;
    try {
      const servers = await raceTimeout(
        [runtime.mcpServerStatus()],
        MCP_STATUS_TIMEOUT_MS,
        () => new Error("timed out"),
        { unref: true },
      );
      if (activeTurn() === turn) updateMcpStatus(claudeMcpStatuses(servers, mcpStatuses));
    } catch {
      // Status must never affect the turn.
    } finally {
      mcpStatusInFlight = false;
    }
    const active = activeTurn();
    // A newer turn was turned away while this call was out, and needs its own.
    if (active && active !== turn) {
      void refreshMcpStatus();
      return;
    }
    if (
      active === turn
      && Date.now() < turn.mcpPollDeadline
      && mcpStatuses?.some(({ status }) => status === "connecting")
    ) {
      stopPoll();
      mcpPollTimer = setTimeout(() => void refreshMcpStatus(), MCP_STATUS_POLL_MS);
      mcpPollTimer.unref?.();
    }
  };

  return {
    fromInit(servers) {
      updateMcpStatus(claudeMcpStatuses(servers, mcpStatuses));
      void refreshMcpStatus();
    },
    turnStarted() {
      // A first turn hears from the init line instead: asking before the CLI
      // is up would only sit waiting.
      if (!mcpStatuses) return;
      emitMcpStatus();
      void refreshMcpStatus();
    },
    stopPoll,
  };
}
