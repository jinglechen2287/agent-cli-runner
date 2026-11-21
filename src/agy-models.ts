/**
 * agy's model list, read the way T3 Code reads it: open a throwaway ACP
 * session, take the model option's values, and select each model in turn to
 * read its thinking levels (they're reported for the selected model only).
 * The session never runs a prompt, so agy saves nothing; its files are
 * removed anyway.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgyAcp } from "./agy-client.js";
import { agyDataRoot } from "./agy-paths.js";
import { removeAgySessionFiles } from "./agy-session.js";
import { AgyTurnError } from "./errors.js";
import { isRecord } from "./internal.js";

export interface AgyModelDescriptor {
  /** The model option value agy takes in `session/set_config_option`. */
  id: string;
  label: string;
  /** The model's thinking levels, empty when it has none. */
  efforts: string[];
  /** The thinking level agy selects for it. */
  defaultEffort?: string;
  /** agy's current model for a new session. */
  isCurrent: boolean;
}

const DISCOVERY_TIMEOUT_MS = 30_000;

interface SelectOption {
  id: string;
  currentValue?: string;
  values: Array<{ value: string; name?: string }>;
}

function selectOption(options: unknown, category: string): SelectOption | undefined {
  if (!Array.isArray(options)) return undefined;
  const option = options.filter(isRecord).find((candidate) => candidate.category === category)
    ?? options.filter(isRecord).find((candidate) => candidate.id === category);
  if (!option || typeof option.id !== "string") return undefined;
  const values = Array.isArray(option.options)
    ? option.options.filter(isRecord).flatMap((choice) => typeof choice.value === "string"
      ? [{ value: choice.value, ...(typeof choice.name === "string" ? { name: choice.name } : {}) }]
      : [])
    : [];
  return {
    id: option.id,
    ...(typeof option.currentValue === "string" ? { currentValue: option.currentValue } : {}),
    values,
  };
}

/** Every model agy offers this account, with its thinking levels. */
/** agy's `--app-data-dir` and `--gemini-dir`, for a host whose sessions use
 * their own profile. */
export interface AgyDiscoveryFolders {
  appDataDir?: string;
  geminiDir?: string;
}

export async function listAgyModels(
  executablePath: string,
  _cwd: string,
  folders: AgyDiscoveryFolders = {},
): Promise<AgyModelDescriptor[]> {
  const cwd = await mkdtemp(join(tmpdir(), "agent-cli-runner-agy-"));
  const env = process.env;
  try {
    const { client, whenExited } = await startAgyAcp({ executablePath, cwd, env, ...folders });
    let sessionId: string | undefined;
    const deadline = setTimeout(() => client.close(), DISCOVERY_TIMEOUT_MS);
    deadline.unref?.();
    try {
      const opened = await client.request("session/new", { cwd, mcpServers: [] }, DISCOVERY_TIMEOUT_MS);
      const record = isRecord(opened) ? opened : {};
      if (typeof record.sessionId !== "string") throw new AgyTurnError("agy did not return a session id");
      sessionId = record.sessionId;
      const modelOption = selectOption(record.configOptions, "model");
      if (!modelOption) throw new AgyTurnError("agy offered no model option");
      const current = modelOption.currentValue;
      const models: AgyModelDescriptor[] = [];
      for (const choice of modelOption.values) {
        const response = await client.request("session/set_config_option", {
          sessionId,
          configId: modelOption.id,
          value: choice.value,
        });
        const thought = selectOption(isRecord(response) ? response.configOptions : undefined, "thought_level");
        models.push({
          id: choice.value,
          label: choice.name ?? choice.value,
          efforts: thought?.values.map((level) => level.value) ?? [],
          ...(thought?.currentValue ? { defaultEffort: thought.currentValue } : {}),
          isCurrent: choice.value === current,
        });
      }
      return models;
    } finally {
      clearTimeout(deadline);
      if (sessionId) await client.request("session/close", { sessionId }, 2_000).catch(() => {});
      client.close();
      await whenExited;
      if (sessionId) await removeAgySessionFiles(agyDataRoot({ env, ...folders }), sessionId);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
