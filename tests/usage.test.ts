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

  // Mirrors Claude Code's own model registry: the window it reports in a
  // turn's `modelUsage` for each model's bare id.
  it.each([
    ["claude-opus-4-0", 200_000],
    ["claude-opus-4", 200_000],
    ["claude-opus-4-1", 200_000],
    ["claude-opus-4-5", 200_000],
    ["claude-opus-4-6", 200_000],
    ["claude-sonnet-4-0", 200_000],
    ["claude-sonnet-4", 200_000],
    ["claude-sonnet-4-5", 200_000],
    ["claude-sonnet-4-6", 200_000],
    ["claude-haiku-4-5", 200_000],
    ["claude-opus-4-7", 1_000_000],
    ["claude-opus-4-8", 1_000_000],
    ["claude-opus-5", 1_000_000],
    ["claude-opus-5-5", 1_000_000],
    ["claude-sonnet-5", 1_000_000],
    ["claude-sonnet-5-5", 1_000_000],
    ["claude-haiku-5-5", 1_000_000],
    ["claude-fable-5", 1_000_000],
    ["claude-fable-5-1", 1_000_000],
    ["claude-mythos-5", 1_000_000],
    ["claude-mythos-5-1", 1_000_000],
  ])("gives %s the window Claude Code runs it at", (model, window) => {
    expect(contextWindowForModel(model)).toBe(window);
  });

  it("gives any Claude model a 1M window under the [1m] marker", () => {
    expect(contextWindowForModel("claude-opus-4-6[1m]")).toBe(1_000_000);
    expect(contextWindowForModel("claude-sonnet-4-6[1M]")).toBe(1_000_000);
    expect(contextWindowForModel("claude-sonnet-4-5-1m")).toBe(1_000_000);
  });

  it("resolves dated, Bedrock and Vertex spellings to the same model", () => {
    expect(contextWindowForModel("claude-opus-4-5-20251101")).toBe(200_000);
    expect(contextWindowForModel("claude-sonnet-4-20250514")).toBe(200_000);
    expect(contextWindowForModel("us.anthropic.claude-opus-4-8-v1:0")).toBe(1_000_000);
    expect(contextWindowForModel("claude-opus-4-5@20251101")).toBe(200_000);
    expect(contextWindowForModel("anthropic.claude-sonnet-5-5")).toBe(1_000_000);
  });

  it("guesses 1M for an unlisted Claude 5+ model and 200k for an older one", () => {
    expect(contextWindowForModel("claude-opus-6")).toBe(1_000_000);
    expect(contextWindowForModel("claude-haiku-4-9")).toBe(200_000);
    expect(contextWindowForModel("claude-3-5-sonnet-20241022")).toBe(200_000);
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
