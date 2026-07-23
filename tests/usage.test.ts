import { describe, expect, it } from "vitest";
import { contextWindowForModel, KNOWN_CONTEXT_WINDOWS } from "../src/index.js";

describe("contextWindowForModel", () => {
  it("returns undefined for a missing or empty model", () => {
    expect(contextWindowForModel(undefined)).toBeUndefined();
    expect(contextWindowForModel("")).toBeUndefined();
    expect(contextWindowForModel("   ")).toBeUndefined();
  });

  it("resolves known Codex catalog models exactly", () => {
    expect(contextWindowForModel("gpt-5.5")).toBe(272_000);
    expect(contextWindowForModel("gpt-5.6-sol")).toBe(372_000);
    expect(contextWindowForModel("GPT-5.6-Sol")).toBe(372_000);
    expect(KNOWN_CONTEXT_WINDOWS["gpt-5.6-terra"]).toBe(372_000);
  });

  it("falls back to Codex family rules for unlisted gpt-5 models", () => {
    expect(contextWindowForModel("gpt-5.6-nova")).toBe(372_000);
    expect(contextWindowForModel("gpt-5.9")).toBe(272_000);
  });

  it("gives Claude models a 200k window, and 1M for [1m] variants", () => {
    expect(contextWindowForModel("claude-opus-4-8")).toBe(200_000);
    expect(contextWindowForModel("claude-sonnet-5")).toBe(200_000);
    expect(contextWindowForModel("claude-opus-4-8[1m]")).toBe(1_000_000);
  });

  it("gives Fable and Mythos a native 1M window without a [1m] marker", () => {
    expect(contextWindowForModel("claude-fable-5")).toBe(1_000_000);
    expect(contextWindowForModel("Claude-Fable-5")).toBe(1_000_000);
    expect(contextWindowForModel("claude-mythos-5")).toBe(1_000_000);
    expect(contextWindowForModel("claude-mythos-preview")).toBe(1_000_000);
  });

  it("returns undefined for unrecognized models", () => {
    expect(contextWindowForModel("llama-3")).toBeUndefined();
  });
});
