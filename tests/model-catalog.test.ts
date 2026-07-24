import { describe, expect, it } from "vitest";
import {
  collectCodexModels,
  createModelCatalogService,
  parseClaudeCliHelp,
  type CodexModelDescriptor,
} from "../src/model-catalog.js";

describe("model catalog", () => {
  it("uses moving Claude aliases and allows custom model names", async () => {
    const service = createModelCatalogService(
      { codexPath: "/bin/codex", claudePath: "/bin/claude", defaultEffort: "high" },
      {
        getClaudeCapabilities: async () => ({
          aliases: ["fable", "opus", "sonnet"],
          efforts: ["low", "medium", "high", "xhigh", "max"],
        }),
      },
    );
    const catalog = await service.getCatalog("claude", "/tmp");

    expect(catalog.source).toBe("claude-cli");
    expect(catalog.supportsCustomModel).toBe(true);
    expect(catalog.models.map((model) => model.id)).toContain("default");
    expect(catalog.models.map((model) => model.id)).toContain("fable");
    expect(catalog.models.map((model) => model.id)).toContain("opus");
    expect(catalog.models.find((model) => model.id === "default")?.defaultEffort).toBe("high");
    expect(service.validateSelection(catalog, { model: "default" }))
      .toEqual({ model: "default", effort: "high", serviceTier: null });
    expect(service.validateSelection(catalog, { model: null, effort: "high" }))
      .toEqual({ model: null, effort: "high", serviceTier: null });
    expect(service.validateSelection(catalog, { model: "private-gateway-model", effort: "high" }))
      .toEqual({ model: "private-gateway-model", effort: "high", serviceTier: null });
  });

  it("resolves no default effort when the host sets no policy", async () => {
    const service = createModelCatalogService(
      {},
      {
        getClaudeCapabilities: async () => ({
          aliases: ["fable", "opus"],
          efforts: ["low", "medium", "high"],
        }),
      },
    );
    const catalog = await service.getCatalog("claude", "/tmp");

    expect(catalog.models.find((model) => model.id === "default")?.defaultEffort).toBeNull();
    // No policy and no requested effort: the selection omits effort so the
    // CLI/config default applies.
    expect(service.validateSelection(catalog, { model: "default" }))
      .toEqual({ model: "default", effort: null, serviceTier: null });
  });

  it("parses model aliases and effort levels from the installed Claude CLI help", () => {
    expect(parseClaudeCliHelp(`
  --effort <level>  Effort level for the current session
                    (low, medium, high, xhigh, max)
  --model <model>   Model for the current session. Provide an alias for the latest
                    model (e.g. 'fable', 'opus', or 'sonnet') or a
                    model's full name (e.g. 'claude-fable-5').
  --verbose         More output
    `)).toEqual({
      aliases: ["fable", "opus", "sonnet"],
      efforts: ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("falls back to stable Claude aliases when CLI discovery is unavailable", async () => {
    const service = createModelCatalogService(
      { codexPath: "/bin/codex", claudePath: "/missing/claude" },
      { getClaudeCapabilities: async () => { throw new Error("missing CLI"); } },
    );

    const catalog = await service.getCatalog("claude", "/tmp");

    expect(catalog.source).toBe("claude-fallback");
    expect(catalog.models.map((model) => model.id)).toEqual([
      "default",
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  it("maps Codex's live model and reasoning metadata", async () => {
    const discovered: CodexModelDescriptor[] = [{
      model: "gpt-live",
      displayName: "GPT Live",
      description: "Current account model",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "high" },
      ],
      serviceTiers: [{
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      }],
    }];
    const service = createModelCatalogService(
      { codexPath: "/bin/codex", defaultEffort: "high" },
      { listCodexModels: async () => discovered },
    );
    const catalog = await service.getCatalog("codex", "/tmp");

    expect(catalog.source).toBe("codex-app-server");
    expect(catalog.models).toEqual([{
      id: "gpt-live",
      label: "GPT Live",
      description: "Current account model",
      efforts: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
      serviceTiers: [{
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      }],
      defaultEffort: "high",
      isDefault: true,
    }]);
    expect(service.validateSelection(catalog, { model: null })).toEqual({
      model: null,
      effort: "high",
      serviceTier: null,
    });
    expect(service.validateSelection(catalog, {
      model: "gpt-live",
      effort: "high",
      serviceTier: "priority",
    })).toEqual({
      model: "gpt-live",
      effort: "high",
      serviceTier: "priority",
    });
    expect(() => service.validateSelection(catalog, {
      model: "gpt-live",
      effort: "xhigh",
    })).toThrow("does not support effort");
    expect(() => service.validateSelection(catalog, {
      model: "gpt-live",
      effort: "high",
      serviceTier: "flex",
    })).toThrow("does not support service tier");
  });

  it("advertises the provider default effort when the host sets no policy", async () => {
    const service = createModelCatalogService(
      {},
      {
        listCodexModels: async () => [{
          model: "gpt-live",
          isDefault: true,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "high" },
          ],
        }],
      },
    );
    const catalog = await service.getCatalog("codex", "/tmp");

    expect(catalog.models[0]?.defaultEffort).toBe("low");
    expect(service.validateSelection(catalog, { model: null }))
      .toEqual({ model: null, effort: "low", serviceTier: null });
  });

  it("normalizes whitespace in model IDs returned by Codex", async () => {
    const service = createModelCatalogService(
      { codexPath: "/bin/codex", codexModel: "gpt-live" },
      { listCodexModels: async () => [{ model: "  gpt-live  ", displayName: " GPT Live " }] },
    );

    const catalog = await service.getCatalog("codex", "/tmp");

    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({ id: "gpt-live", label: "GPT Live", isDefault: true });
  });

  it("treats the configured model as the single default when it matches a discovered model", async () => {
    const service = createModelCatalogService(
      { codexPath: "/bin/codex", codexModel: "gpt-override" },
      {
        listCodexModels: async () => [
          { model: "gpt-account-default", isDefault: true },
          { model: "gpt-override", isDefault: false },
        ],
      },
    );

    const catalog = await service.getCatalog("codex", "/tmp");

    expect(catalog.models.filter((model) => model.isDefault).map((model) => model.id))
      .toEqual(["gpt-override"]);
  });

  it("ignores malformed model entries returned by Codex", async () => {
    const service = createModelCatalogService(
      { codexPath: "/bin/codex" },
      {
        listCodexModels: async () => [
          { model: null } as unknown as CodexModelDescriptor,
          { model: "gpt-valid" },
        ],
      },
    );

    const catalog = await service.getCatalog("codex", "/tmp");

    expect(catalog.models.map((model) => model.id)).toEqual(["gpt-valid"]);
  });

  it("bounds Codex model pagination when a cursor repeats forever", async () => {
    let requests = 0;
    const models = await collectCodexModels(async () => {
      requests += 1;
      return { data: [{ model: `model-${requests}` }], nextCursor: "same" };
    });

    expect(requests).toBe(50);
    expect(models).toHaveLength(50);
  });

  it("falls back to the configured model when live Codex discovery is unavailable", async () => {
    const service = createModelCatalogService(
      {
        codexPath: "/missing/codex",
        codexModel: "gpt-configured",
        defaultEffort: "high",
        configuredModelDescription: "Configured with CODEX_MODEL",
      },
      { listCodexModels: async () => { throw new Error("missing CLI"); } },
    );

    const catalog = await service.getCatalog("codex", "/tmp");

    expect(catalog.source).toBe("codex-config");
    expect(catalog.models).toEqual([expect.objectContaining({
      id: "gpt-configured",
      description: "Configured with CODEX_MODEL",
      defaultEffort: "high",
      efforts: [{ id: "high", label: "High" }],
      isDefault: true,
    })]);
  });

  it("keeps the configured-model fallback permissive when the host sets no policy", async () => {
    const service = createModelCatalogService(
      { codexModel: "gpt-configured" },
      { listCodexModels: async () => { throw new Error("missing CLI"); } },
    );

    const catalog = await service.getCatalog("codex", "/tmp");

    expect(catalog.models).toEqual([expect.objectContaining({
      id: "gpt-configured",
      description: "Configured model",
      defaultEffort: null,
      efforts: [],
    })]);
    // The effort domain is unknown here — any requested effort passes
    // through rather than being rejected against an empty list.
    expect(service.validateSelection(catalog, { model: "gpt-configured", effort: "xhigh" }))
      .toEqual({ model: "gpt-configured", effort: "xhigh", serviceTier: null });
  });
});
