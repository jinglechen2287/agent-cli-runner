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

describe("model catalog custom-model selection", () => {
  it("inherits the host default effort for a custom model with no saved effort", async () => {
    const service = createModelCatalogService(
      { defaultEffort: "high" },
      {
        getClaudeCapabilities: async () => ({
          aliases: ["fable", "opus"],
          efforts: ["low", "medium", "high"],
        }),
      },
    );
    const catalog = await service.getCatalog("claude", "/tmp");

    // A model id outside the catalog must still send the effort the UI
    // advertises as the default, not silently drop it.
    expect(service.validateSelection(catalog, { model: "claude-opus-4-5" }))
      .toEqual({ model: "claude-opus-4-5", effort: "high", serviceTier: null });
  });
});

describe("agy model catalog", () => {
  const discovered = [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"], defaultEffort: "high", isCurrent: true },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)", efforts: [], isCurrent: false },
  ];

  it("lists a default entry first, then every model with its thinking levels", async () => {
    const service = createModelCatalogService({ agyPath: "/bin/agy" }, {
      listAgyModels: async (path, cwd) => {
        expect([path, cwd]).toEqual(["/bin/agy", "/tmp"]);
        return discovered;
      },
    });
    const catalog = await service.getCatalog("agy", "/tmp");
    expect(catalog).toMatchObject({ provider: "agy", source: "agy-acp", supportsCustomModel: false });
    expect(catalog.models.map((model) => [model.id, model.isDefault, model.efforts.map((effort) => effort.id), model.defaultEffort]))
      .toEqual([
        ["default", true, ["low", "medium", "high"], "high"],
        ["gemini-3.8-flash", false, ["low", "medium", "high"], "high"],
        ["claude-sonnet-4-6", false, [], null],
      ]);
    expect(catalog.models[0]?.label).toContain("Gemini 3.8 Flash");
    expect(service.validateSelection(catalog, { model: "default" })).toEqual({ model: "default", effort: "high", serviceTier: null });
    expect(() => service.validateSelection(catalog, { model: "nope" })).toThrow();
  });

  it("discovers in the data folders it is given", async () => {
    const seen: unknown[] = [];
    const service = createModelCatalogService({ agyAppDataDir: "merlo", agyGeminiDir: "/g" }, {
      listAgyModels: async (_path, _cwd, folders) => {
        seen.push(folders);
        return discovered;
      },
    });
    await service.getCatalog("agy", "/tmp");
    expect(seen).toEqual([{ appDataDir: "merlo", geminiDir: "/g" }]);
  });

  it("advertises the host's default effort when the model offers it", async () => {
    const service = createModelCatalogService({ defaultEffort: "low" }, { listAgyModels: async () => discovered });
    const catalog = await service.getCatalog("agy", "/tmp");
    expect(catalog.models.find((model) => model.id === "gemini-3.8-flash")?.defaultEffort).toBe("low");
    expect(catalog.models.find((model) => model.id === "claude-sonnet-4-6")?.defaultEffort).toBeNull();
  });

  it("labels the default entry plainly when agy names no current model, and drops an unlisted default effort", async () => {
    const service = createModelCatalogService({ defaultEffort: "max" }, {
      listAgyModels: async () => [
        { ...discovered[0]!, isCurrent: false, defaultEffort: "max" },
        discovered[1]!,
      ],
    });
    const catalog = await service.getCatalog("agy", "/tmp");
    expect(catalog.models[0]).toMatchObject({ id: "default", label: "Default", efforts: [], defaultEffort: null });
    expect(catalog.models.find((model) => model.id === "gemini-3.8-flash")?.defaultEffort).toBeNull();
  });

  it("accepts a legacy id whose family is listed, as the session does", async () => {
    const service = createModelCatalogService({}, { listAgyModels: async () => discovered });
    const catalog = await service.getCatalog("agy", "/tmp");
    expect(service.validateSelection(catalog, { model: "gemini-3.8-flash-high" }))
      .toEqual({ model: "gemini-3.8-flash-high", effort: "high", serviceTier: null });
    expect(() => service.validateSelection(catalog, { model: "gemini-3.8" })).toThrow();
    expect(() => service.validateSelection(catalog, { model: "default-x" })).toThrow();
  });

  it("falls back to the configured model, or rethrows without one", async () => {
    const failing = async () => { throw new Error("agy needs you to sign in"); };
    const configured = createModelCatalogService({ agyModel: "gemini-3.8-flash" }, { listAgyModels: failing });
    const catalog = await configured.getCatalog("agy", "/tmp");
    expect(catalog.source).toBe("agy-config");
    expect(catalog.models.map((model) => [model.id, model.isDefault])).toEqual([["gemini-3.8-flash", true]]);
    const bare = createModelCatalogService({}, { listAgyModels: failing });
    await expect(bare.getCatalog("agy", "/tmp")).rejects.toThrow("sign in");
  });
});
