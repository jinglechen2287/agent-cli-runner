/**
 * Live model discovery for every provider, shared by hosts that let users
 * pick a model/effort: Codex models come from the app-server's `model/list`
 * API (with per-model reasoning efforts and service tiers); Claude aliases
 * and effort levels are parsed from the installed CLI's `--help`, with
 * static fallbacks when discovery is unavailable; agy models and their
 * thinking levels come from a throwaway ACP session.
 *
 * Policy stays with the host: `config.defaultEffort` names the effort a host
 * sends when a thread has none saved (advertised as each model's
 * `defaultEffort` so UIs match the runs). Hosts that omit it get the
 * provider-reported default, or null — meaning "omit the option and let the
 * CLI/config decide".
 */

import { listAgyModels, type AgyDiscoveryFolders, type AgyModelDescriptor } from "./agy-models.js";
import { createCodexAppServerClient } from "./codex-client.js";
import { childEnv, execCli } from "./process.js";
import type { AgentProvider } from "./providers.js";

export type ModelCatalogProvider = AgentProvider;
export type { AgyModelDescriptor } from "./agy-models.js";

export interface ModelEffortOption {
  id: string;
  label: string;
}

export interface ModelServiceTierOption {
  id: string;
  name: string;
  description: string;
}

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  efforts: ModelEffortOption[];
  serviceTiers: ModelServiceTierOption[];
  defaultEffort: string | null;
  isDefault: boolean;
}

export interface ModelCatalog {
  provider: ModelCatalogProvider;
  source: "codex-app-server" | "codex-config" | "claude-cli" | "claude-fallback" | "agy-acp" | "agy-config";
  fetchedAt: string;
  supportsCustomModel: boolean;
  models: ModelOption[];
}

export interface ModelSelectionInput {
  model: string | null;
  effort?: string | null;
  serviceTier?: string | null;
}

export interface ModelSelection {
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
}

export interface CodexModelDescriptor {
  model: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string | null;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
  serviceTiers?: ModelServiceTierOption[];
}

interface CodexModelListResponse {
  data?: CodexModelDescriptor[];
  nextCursor?: string | null;
}

const MAX_CODEX_MODEL_PAGES = 50;

export async function collectCodexModels(
  requestPage: (cursor?: string) => Promise<CodexModelListResponse>,
): Promise<CodexModelDescriptor[]> {
  const models: CodexModelDescriptor[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < MAX_CODEX_MODEL_PAGES; page += 1) {
    const response = await requestPage(cursor ?? undefined);
    if (Array.isArray(response.data)) models.push(...response.data);
    cursor = response.nextCursor;
    if (!cursor) break;
  }
  return models;
}

export interface ModelCatalogService {
  getCatalog(provider: ModelCatalogProvider, cwd: string): Promise<ModelCatalog>;
  validateSelection(catalog: ModelCatalog, input: ModelSelectionInput): ModelSelection;
}

export interface ModelCatalogConfig {
  /** Codex binary for `model/list` discovery. Defaults to "codex" on PATH. */
  codexPath?: string;
  /** Claude binary for `--help` discovery. Defaults to "claude" on PATH. */
  claudePath?: string;
  /** A host-configured Codex model: always present in the catalog (marked
   * default), and the discovery fallback when the app-server is unreachable. */
  codexModel?: string;
  /** The effort the host sends when a thread has none saved, advertised as
   * every model's `defaultEffort`. Omitted = the provider-reported default,
   * or null ("omit the option; the CLI/config decides"). */
  defaultEffort?: string;
  /** Description shown on the synthetic configured-model entry. */
  configuredModelDescription?: string;
  /** agy binary for ACP discovery. Defaults to "agy" on PATH. */
  agyPath?: string;
  /** agy's `--app-data-dir` and `--gemini-dir` for discovery, so the catalog
   * reads the same profile the host's sessions use. */
  agyAppDataDir?: string;
  agyGeminiDir?: string;
  /** The catalog's only entry when agy discovery fails. Without it the
   * discovery error is thrown. */
  agyModel?: string;
}

export interface ModelCatalogDeps {
  listCodexModels?: (executablePath: string, cwd: string) => Promise<CodexModelDescriptor[]>;
  getClaudeCapabilities?: (executablePath: string, cwd: string) => Promise<ClaudeCliCapabilities>;
  listAgyModels?: (executablePath: string, cwd: string, folders?: AgyDiscoveryFolders) => Promise<AgyModelDescriptor[]>;
  now?: () => Date;
}

const CLAUDE_FALLBACK_ALIASES = ["opus", "sonnet", "haiku"];
const CLAUDE_FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export interface ClaudeCliCapabilities {
  aliases: string[];
  efforts: string[];
}

/** A display label for an effort or a model alias: "xhigh" reads "Extra High",
 * anything else is capitalized. */
function optionLabel(value: string): string {
  if (value === "xhigh") return "Extra High";
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function optionBlock(help: string, option: string): string {
  const start = help.indexOf(option);
  if (start < 0) return "";
  const remainder = help.slice(start);
  const nextOption = remainder.slice(option.length).search(/\n\s{2}--[a-z]/i);
  return nextOption < 0 ? remainder : remainder.slice(0, option.length + nextOption);
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function parseClaudeCliHelp(help: string): ClaudeCliCapabilities {
  const modelHelp = optionBlock(help, "--model <model>");
  const aliasHelp = modelHelp.split(/\bor\s+a\s+model(?:'s)?\b/i)[0] ?? "";
  const aliases = uniqueValues(
    [...aliasHelp.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? ""),
  ).filter((alias) => /^[a-z0-9][a-z0-9._[\]-]*$/i.test(alias));
  const effortHelp = optionBlock(help, "--effort <level>");
  const effortList = effortHelp.match(/\(([^)]+)\)/)?.[1] ?? "";
  const efforts = uniqueValues(effortList.split(","));
  return { aliases, efforts };
}

async function readClaudeCliCapabilities(
  executablePath: string,
  cwd: string,
): Promise<ClaudeCliCapabilities> {
  // Same nesting-guard strip every other claude spawn applies, so
  // discovery still works for hosts running inside a Claude Code
  // session instead of silently degrading to the static fallback.
  const { stdout, stderr, exitCode } = await execCli(executablePath, ["--help"], {
    env: childEnv("claude"),
    cwd,
    timeoutMs: 5_000,
  });
  if (exitCode !== 0) throw new Error(`${executablePath} --help exited with code ${exitCode}`);
  return parseClaudeCliHelp(`${stdout}\n${stderr}`);
}

function claudeModels(
  capabilities: ClaudeCliCapabilities,
  defaultEffort: string | undefined,
): ModelOption[] {
  const aliases = capabilities.aliases.length > 0
    ? capabilities.aliases
    : CLAUDE_FALLBACK_ALIASES;
  const discoveredEfforts = capabilities.efforts.length > 0
    ? capabilities.efforts
    : CLAUDE_FALLBACK_EFFORTS;
  const effortIds = uniqueValues([...discoveredEfforts, ...(defaultEffort ? [defaultEffort] : [])]);
  // Fresh options for each model, so a host editing one model's leaves the
  // rest alone.
  const efforts = (): ModelEffortOption[] =>
    effortIds.map((effort) => ({ id: effort, label: optionLabel(effort) }));
  return [
    {
      id: "default",
      label: "Default",
      description: "Use the model selected by Claude Code and your account",
      efforts: efforts(),
      serviceTiers: [],
      defaultEffort: defaultEffort ?? null,
      isDefault: true,
    },
    ...aliases.filter((alias) => alias !== "default").map((alias) => ({
      id: alias,
      label: optionLabel(alias),
      description: `Latest model exposed by Claude Code's ${alias} alias`,
      efforts: efforts(),
      serviceTiers: [],
      defaultEffort: defaultEffort ?? null,
      isDefault: false,
    })),
  ];
}

async function listCodexModels(
  executablePath: string,
  cwd: string,
): Promise<CodexModelDescriptor[]> {
  const client = await createCodexAppServerClient({ executablePath, cwd });
  try {
    return await collectCodexModels(
      async (cursor) =>
        client.request("model/list", cursor ? { cursor } : {}) as Promise<CodexModelListResponse>,
    );
  } finally {
    client.close();
  }
}

/** The listed model a legacy agy id such as `gemini-3.8-flash-high` belongs
 * to: agy sessions accept those ids, so the catalog does too. */
function legacyAgyFamily(catalog: ModelCatalog, model: string): ModelOption | undefined {
  if (catalog.provider !== "agy") return undefined;
  return catalog.models.find((candidate) => candidate.id !== "default" && model.startsWith(`${candidate.id}-`));
}

export function createModelCatalogService(
  config: ModelCatalogConfig = {},
  deps: ModelCatalogDeps = {},
): ModelCatalogService {
  const discoverCodex = deps.listCodexModels ?? listCodexModels;
  const discoverClaude = deps.getClaudeCapabilities ?? readClaudeCliCapabilities;
  const discoverAgy = deps.listAgyModels ?? listAgyModels;
  const now = deps.now ?? (() => new Date());
  const hostDefaultEffort = config.defaultEffort?.trim() || undefined;

  const claudeCatalog = async (cwd: string): Promise<ModelCatalog> => {
    let capabilities: ClaudeCliCapabilities;
    let source: "claude-cli" | "claude-fallback" = "claude-cli";
    try {
      capabilities = await discoverClaude(config.claudePath ?? "claude", cwd);
    } catch {
      source = "claude-fallback";
      capabilities = {
        aliases: [...CLAUDE_FALLBACK_ALIASES],
        efforts: [...CLAUDE_FALLBACK_EFFORTS],
      };
    }
    return {
      provider: "claude",
      source,
      fetchedAt: now().toISOString(),
      supportsCustomModel: true,
      models: claudeModels(capabilities, hostDefaultEffort),
    };
  };

  const codexCatalog = async (cwd: string): Promise<ModelCatalog> => {
    const configuredModel = config.codexModel?.trim() || undefined;
    let source: "codex-app-server" | "codex-config" = "codex-app-server";
    let discovered: CodexModelDescriptor[];
    try {
      discovered = await discoverCodex(config.codexPath ?? "codex", cwd);
    } catch (error) {
      if (!configuredModel) throw error;
      source = "codex-config";
      discovered = [];
    }
    const visible = discovered
      .filter((model) => typeof model.model === "string")
      .map((model) => ({ ...model, model: model.model.trim() }))
      .filter((model) => !model.hidden && model.model);
    if (configuredModel && !visible.some((model) => model.model === configuredModel)) {
      visible.unshift({
        model: configuredModel,
        displayName: configuredModel,
        description: config.configuredModelDescription ?? "Configured model",
        isDefault: true,
        ...(hostDefaultEffort
          ? {
              defaultReasoningEffort: hostDefaultEffort,
              supportedReasoningEfforts: [{ reasoningEffort: hostDefaultEffort }],
            }
          : {}),
      });
    }
    return {
      provider: "codex",
      source,
      fetchedAt: now().toISOString(),
      supportsCustomModel: false,
      models: visible.map((model) => {
        const providerDefaultEffort = model.defaultReasoningEffort?.trim() || undefined;
        // The host's configured default wins so the UI matches what a run
        // without a saved effort will actually send; the provider's own
        // default stays an available choice.
        const defaultEffort = hostDefaultEffort ?? providerDefaultEffort ?? null;
        const efforts = uniqueValues([
          ...(model.supportedReasoningEfforts ?? []).map(({ reasoningEffort }) => reasoningEffort),
          ...(providerDefaultEffort ? [providerDefaultEffort] : []),
          ...(defaultEffort ? [defaultEffort] : []),
        ]).map((reasoningEffort) => ({
          id: reasoningEffort,
          label: optionLabel(reasoningEffort),
        }));
        return {
          id: model.model,
          label: model.displayName?.trim() || model.model,
          ...(model.description?.trim() ? { description: model.description.trim() } : {}),
          efforts,
          serviceTiers: (model.serviceTiers ?? []).map((tier) => ({ ...tier })),
          defaultEffort,
          isDefault: configuredModel
            ? model.model === configuredModel
            : model.isDefault === true,
        };
      }),
    };
  };

  const agyCatalog = async (cwd: string): Promise<ModelCatalog> => {
    const configuredModel = config.agyModel?.trim() || undefined;
    const efforts = (ids: readonly string[]): ModelEffortOption[] =>
      ids.map((effort) => ({ id: effort, label: optionLabel(effort) }));
    // The host's default wins where the model offers it, so the UI matches
    // what a run without a saved effort sends; agy's own default otherwise.
    const defaultEffortFor = (model: AgyModelDescriptor): string | null =>
      hostDefaultEffort && model.efforts.includes(hostDefaultEffort)
        ? hostDefaultEffort
        : model.defaultEffort && model.efforts.includes(model.defaultEffort) ? model.defaultEffort : null;
    let discovered: AgyModelDescriptor[];
    try {
      const folders: AgyDiscoveryFolders = {
        ...(config.agyAppDataDir ? { appDataDir: config.agyAppDataDir } : {}),
        ...(config.agyGeminiDir ? { geminiDir: config.agyGeminiDir } : {}),
      };
      discovered = Object.keys(folders).length > 0
        ? await discoverAgy(config.agyPath ?? "agy", cwd, folders)
        : await discoverAgy(config.agyPath ?? "agy", cwd);
    } catch (error) {
      if (!configuredModel) throw error;
      return {
        provider: "agy",
        source: "agy-config",
        fetchedAt: now().toISOString(),
        supportsCustomModel: false,
        models: [{
          id: configuredModel,
          label: configuredModel,
          description: config.configuredModelDescription ?? "Configured model",
          efforts: efforts(hostDefaultEffort ? [hostDefaultEffort] : []),
          serviceTiers: [],
          defaultEffort: hostDefaultEffort ?? null,
          isDefault: true,
        }],
      };
    }
    // Only the model agy reports as current speaks for "default".
    const current = discovered.find((model) => model.isCurrent);
    const models: ModelOption[] = discovered.map((model) => ({
      id: model.id,
      label: model.label,
      efforts: efforts(model.efforts),
      serviceTiers: [],
      defaultEffort: defaultEffortFor(model),
      isDefault: false,
    }));
    return {
      provider: "agy",
      source: "agy-acp",
      fetchedAt: now().toISOString(),
      supportsCustomModel: false,
      models: [
        {
          id: "default",
          label: current ? `Default (${current.label})` : "Default",
          description: "Keep the model agy selects for this account",
          efforts: efforts(current?.efforts ?? []),
          serviceTiers: [],
          defaultEffort: current ? defaultEffortFor(current) : null,
          isDefault: true,
        },
        ...models,
      ],
    };
  };

  return {
    getCatalog(provider, cwd) {
      switch (provider) {
        case "claude":
          return claudeCatalog(cwd);
        case "codex":
          return codexCatalog(cwd);
        case "agy":
          return agyCatalog(cwd);
      }
    },

    validateSelection(catalog, input) {
      const model = input.model?.trim() || null;
      const markedDefault = catalog.models.find((candidate) => candidate.isDefault);
      const defaultOption = markedDefault ?? catalog.models[0];
      const option = model
        ? catalog.models.find((candidate) => candidate.id === model) ?? legacyAgyFamily(catalog, model)
        : defaultOption;
      if (model && !option && !catalog.supportsCustomModel) {
        throw new Error(`Model is not available: ${model}`);
      }
      // A custom model (no catalog entry) still inherits the host's default
      // effort, which every catalog entry advertises via the default model —
      // otherwise the run silently drops the effort the UI displays.
      const requestedEffort = input.effort === undefined
        ? (option ?? defaultOption)?.defaultEffort ?? null
        : input.effort?.trim() || null;
      const supportedEfforts = (option ?? markedDefault)?.efforts.map((candidate) => candidate.id)
        ?? CLAUDE_FALLBACK_EFFORTS;
      // An empty supported list means the effort domain is unknown (e.g. a
      // config-fallback entry) — stay permissive rather than rejecting all.
      if (
        requestedEffort
        && supportedEfforts.length > 0
        && !supportedEfforts.includes(requestedEffort)
      ) {
        throw new Error(`${model ?? "Default model"} does not support effort ${requestedEffort}`);
      }
      const requestedServiceTier = input.serviceTier?.trim() || null;
      const supportedServiceTiers = option?.serviceTiers.map((candidate) => candidate.id) ?? [];
      if (requestedServiceTier && !supportedServiceTiers.includes(requestedServiceTier)) {
        throw new Error(
          `${model ?? "Default model"} does not support service tier ${requestedServiceTier}`,
        );
      }
      return { model, effort: requestedEffort, serviceTier: requestedServiceTier };
    },
  };
}
