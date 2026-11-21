import { describe, expect, it } from "vitest";
import {
  AgyAuthError,
  AgyTurnError,
  CodexTurnError,
  ProviderTurnError,
} from "../src/index.js";

describe("ProviderTurnError", () => {
  it("is the base of every provider's turn error", () => {
    const codex = new CodexTurnError("Codex error: boom");
    expect(codex).toBeInstanceOf(ProviderTurnError);
    expect(codex).toBeInstanceOf(CodexTurnError);
    expect(codex.name).toBe("CodexTurnError");
    expect(codex.message).toBe("Codex error: boom");
    expect(codex).toMatchObject({ provider: "codex", kind: "provider_error", retryable: false });
    codex.exitCode = 3;
    expect(codex.exitCode).toBe(3);
  });

  it("carries the same fields for agy usage limits and Codex failures", () => {
    const failures: unknown[] = [
      new AgyTurnError("quota", { kind: "usage_limit", retryable: true, resetAt: "2026-11-21T00:00:00Z", code: "RESOURCE_EXHAUSTED" }),
      new CodexTurnError("Codex error: boom"),
    ];
    const read = failures.map((error) => {
      if (!(error instanceof ProviderTurnError)) throw new Error("not a ProviderTurnError");
      return { provider: error.provider, kind: error.kind, retryable: error.retryable, resetAt: error.resetAt };
    });
    expect(read).toEqual([
      { provider: "agy", kind: "usage_limit", retryable: true, resetAt: "2026-11-21T00:00:00Z" },
      { provider: "codex", kind: "provider_error", retryable: false, resetAt: undefined },
    ]);
  });

  it("gives agy errors their extra fields", () => {
    const turn = new AgyTurnError("stopped", { stopReason: "max_tokens", broken: true, text: "partial" });
    expect(turn).toMatchObject({ provider: "agy", name: "AgyTurnError", stopReason: "max_tokens", broken: true, text: "partial" });
    const auth = new AgyAuthError("sign in", { code: -32000, url: "https://accounts.example" });
    expect(auth).toBeInstanceOf(ProviderTurnError);
    expect(auth).toMatchObject({ provider: "agy", kind: "auth_required", code: -32000, url: "https://accounts.example" });
  });
});
