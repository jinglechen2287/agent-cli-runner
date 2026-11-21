import { describe, expect, it } from "vitest";
import { PROVIDER_CAPABILITIES, type AgentProvider, type ProviderCapabilities } from "../src/index.js";

describe("PROVIDER_CAPABILITIES", () => {
  it("states each provider's capabilities", () => {
    const expected: Record<AgentProvider, ProviderCapabilities> = {
      claude: {
        serviceTiers: false, compactionFocus: true, sideFork: true, lastingFork: true, deleteSession: true,
        mcpStatus: true, mcpElicitation: true, toolHooks: true, permissionCallback: false,
        readOnlyTurns: true, images: false, failedTurn: "resolves",
      },
      codex: {
        serviceTiers: true, compactionFocus: false, sideFork: true, lastingFork: true, deleteSession: false,
        mcpStatus: true, mcpElicitation: true, toolHooks: false, permissionCallback: false,
        readOnlyTurns: true, images: true, failedTurn: "rejects",
      },
      agy: {
        serviceTiers: false, compactionFocus: true, sideFork: false, lastingFork: false, deleteSession: false,
        mcpStatus: false, mcpElicitation: false, toolHooks: false, permissionCallback: true,
        readOnlyTurns: false, images: true, failedTurn: "rejects",
      },
    };
    expect(PROVIDER_CAPABILITIES).toEqual(expected);
  });

  it("cannot be changed at runtime", () => {
    expect(Object.isFrozen(PROVIDER_CAPABILITIES)).toBe(true);
    for (const capabilities of Object.values(PROVIDER_CAPABILITIES)) {
      expect(Object.isFrozen(capabilities)).toBe(true);
    }
  });
});
