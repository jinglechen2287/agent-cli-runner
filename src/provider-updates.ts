import { execFile } from "node:child_process";
import { filterEnv } from "./internal.js";
import { CLAUDE_STRIPPED_ENV_VARS } from "./run-claude.js";
import { CODEX_STRIPPED_ENV_VARS } from "./run-codex.js";

const CHECK_TIMEOUT_MS = 5_000;
const CLAUDE_RELEASE_BASE_URL = "https://downloads.claude.ai/claude-code-releases";

export type ProviderUpdateProvider = "claude" | "codex";

export type ProviderUpdateState =
  | "current"
  | "update_available"
  | "not_installed"
  | "unknown";

export type ProviderUpdateReason =
  | "cli_not_found"
  | "unsupported_installation"
  | "version_unavailable"
  | "check_failed"
  | null;

export interface ProviderUpdateStatus {
  provider: ProviderUpdateProvider;
  state: ProviderUpdateState;
  installedVersion: string | null;
  latestVersion: string | null;
  channel: "stable" | "latest" | null;
  checkedAt: string;
  reason: ProviderUpdateReason;
}

export interface ProviderUpdateService {
  check(provider: ProviderUpdateProvider): Promise<ProviderUpdateStatus>;
  checkAll(): Promise<ProviderUpdateStatus[]>;
}

export interface ProviderUpdateServiceConfig {
  claudePath?: string;
  codexPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProviderUpdateCommandOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface ProviderUpdateCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProviderUpdateFetchOptions {
  timeoutMs: number;
}

export interface ProviderUpdateServiceDeps {
  runCommand?: (
    executable: string,
    args: readonly string[],
    options: ProviderUpdateCommandOptions,
  ) => Promise<ProviderUpdateCommandResult>;
  fetchText?: (url: string, options: ProviderUpdateFetchOptions) => Promise<string>;
  now?: () => Date;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  version: string;
}

function defaultRunCommand(
  executable: string,
  args: readonly string[],
  options: ProviderUpdateCommandOptions,
): Promise<ProviderUpdateCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 1_000_000,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        if (typeof error.code === "number") {
          resolve({ stdout, stderr, exitCode: error.code });
          return;
        }
        reject(error);
      },
    );
  });
}

async function defaultFetchText(
  url: string,
  options: ProviderUpdateFetchOptions,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "text/plain" },
    });
    if (!response.ok) {
      throw new Error(`Provider update check returned HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseVersion(value: string): ParsedSemver | null {
  const match = value.match(
    /(?:^|[^\d])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?=$|[^0-9A-Za-z.+-])/,
  );
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4]?.split(".") ?? [];
  return {
    major,
    minor,
    patch,
    prerelease,
    version: `${major}.${minor}.${patch}${prerelease.length > 0 ? `-${prerelease.join(".")}` : ""}`,
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftIsNumber = /^\d+$/.test(leftPart);
    const rightIsNumber = /^\d+$/.test(rightPart);
    if (leftIsNumber && rightIsNumber) {
      const normalizedLeft = leftPart.replace(/^0+(?=\d)/, "");
      const normalizedRight = rightPart.replace(/^0+(?=\d)/, "");
      if (normalizedLeft.length !== normalizedRight.length) {
        return normalizedLeft.length < normalizedRight.length ? -1 : 1;
      }
      return normalizedLeft < normalizedRight ? -1 : 1;
    }
    if (leftIsNumber) return -1;
    if (rightIsNumber) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function compareVersions(left: ParsedSemver, right: ParsedSemver): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function isMissingExecutable(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as Error & { code?: unknown }).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownStatus(
  provider: ProviderUpdateProvider,
  checkedAt: string,
  reason: Exclude<ProviderUpdateReason, "cli_not_found" | null>,
  installedVersion: string | null = null,
): ProviderUpdateStatus {
  return {
    provider,
    state: "unknown",
    installedVersion,
    latestVersion: null,
    channel: null,
    checkedAt,
    reason,
  };
}

function statusFromVersions(input: {
  provider: ProviderUpdateProvider;
  installed: ParsedSemver;
  latest: ParsedSemver;
  channel: "stable" | "latest" | null;
  checkedAt: string;
}): ProviderUpdateStatus {
  return {
    provider: input.provider,
    state: compareVersions(input.installed, input.latest) < 0
      ? "update_available"
      : "current",
    installedVersion: input.installed.version,
    latestVersion: input.latest.version,
    channel: input.channel,
    checkedAt: input.checkedAt,
    reason: null,
  };
}

function parseClaudeDoctor(
  output: string,
): { installMethod: string; channel: "stable" | "latest" | null } | null {
  const installMethod = output.match(/^Config install method:\s*(\S+)\s*$/im)?.[1]?.toLowerCase();
  if (!installMethod) return null;
  const rawChannel = output.match(/^Auto-update channel:\s*(\S+)\s*$/im)?.[1]?.toLowerCase();
  const channel = rawChannel === "stable" || rawChannel === "latest" ? rawChannel : null;
  return { installMethod, channel };
}

function parseCodexLatestVersion(output: string): ParsedSemver | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.checks)) return null;
  const updateCheck = parsed.checks["updates.status"];
  if (!isRecord(updateCheck) || !isRecord(updateCheck.details)) return null;
  const latest = updateCheck.details["latest version"];
  return typeof latest === "string" ? parseVersion(latest) : null;
}

export function createProviderUpdateService(
  config: ProviderUpdateServiceConfig = {},
  deps: ProviderUpdateServiceDeps = {},
): ProviderUpdateService {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const fetchText = deps.fetchText ?? defaultFetchText;
  const now = deps.now ?? (() => new Date());
  const baseEnv = config.env ?? process.env;

  async function installedVersion(
    provider: ProviderUpdateProvider,
    executable: string,
    env: NodeJS.ProcessEnv,
    checkedAt: string,
  ): Promise<ParsedSemver | ProviderUpdateStatus> {
    let command: ProviderUpdateCommandResult;
    try {
      command = await runCommand(executable, ["--version"], {
        env,
        timeoutMs: CHECK_TIMEOUT_MS,
      });
    } catch (error) {
      if (isMissingExecutable(error)) {
        return {
          provider,
          state: "not_installed",
          installedVersion: null,
          latestVersion: null,
          channel: null,
          checkedAt,
          reason: "cli_not_found",
        };
      }
      return unknownStatus(provider, checkedAt, "check_failed");
    }
    return parseVersion(`${command.stdout}\n${command.stderr}`)
      ?? unknownStatus(provider, checkedAt, "version_unavailable");
  }

  async function checkClaude(checkedAt: string): Promise<ProviderUpdateStatus> {
    const executable = config.claudePath ?? "claude";
    const env = filterEnv(baseEnv, CLAUDE_STRIPPED_ENV_VARS);
    const installed = await installedVersion("claude", executable, env, checkedAt);
    if ("state" in installed) return installed;

    let doctor: ProviderUpdateCommandResult;
    try {
      doctor = await runCommand(executable, ["doctor"], {
        env,
        timeoutMs: CHECK_TIMEOUT_MS,
      });
    } catch {
      return unknownStatus("claude", checkedAt, "check_failed", installed.version);
    }
    const metadata = parseClaudeDoctor(`${doctor.stdout}\n${doctor.stderr}`);
    if (!metadata) {
      return unknownStatus("claude", checkedAt, "check_failed", installed.version);
    }
    if (metadata.installMethod !== "native") {
      return unknownStatus(
        "claude",
        checkedAt,
        "unsupported_installation",
        installed.version,
      );
    }
    if (!metadata.channel) {
      return unknownStatus("claude", checkedAt, "version_unavailable", installed.version);
    }

    let latest: ParsedSemver | null;
    try {
      const response = await fetchText(
        `${CLAUDE_RELEASE_BASE_URL}/${metadata.channel}`,
        { timeoutMs: CHECK_TIMEOUT_MS },
      );
      latest = parseVersion(response);
    } catch {
      latest = null;
    }
    if (!latest) {
      return {
        ...unknownStatus("claude", checkedAt, "version_unavailable", installed.version),
        channel: metadata.channel,
      };
    }
    return statusFromVersions({
      provider: "claude",
      installed,
      latest,
      channel: metadata.channel,
      checkedAt,
    });
  }

  async function checkCodex(checkedAt: string): Promise<ProviderUpdateStatus> {
    const executable = config.codexPath ?? "codex";
    const env = filterEnv(baseEnv, CODEX_STRIPPED_ENV_VARS);
    const installed = await installedVersion("codex", executable, env, checkedAt);
    if ("state" in installed) return installed;

    let doctor: ProviderUpdateCommandResult;
    try {
      doctor = await runCommand(executable, ["doctor", "--json"], {
        env,
        timeoutMs: CHECK_TIMEOUT_MS,
      });
    } catch {
      return unknownStatus("codex", checkedAt, "check_failed", installed.version);
    }
    const latest = parseCodexLatestVersion(doctor.stdout);
    if (!latest) {
      return unknownStatus("codex", checkedAt, "version_unavailable", installed.version);
    }
    return statusFromVersions({
      provider: "codex",
      installed,
      latest,
      channel: null,
      checkedAt,
    });
  }

  const check = async (provider: ProviderUpdateProvider): Promise<ProviderUpdateStatus> => {
    const checkedAt = now().toISOString();
    return provider === "claude" ? checkClaude(checkedAt) : checkCodex(checkedAt);
  };

  return {
    check,
    checkAll: () => Promise.all([
      check("claude"),
      check("codex"),
    ]),
  };
}
