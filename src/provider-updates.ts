import { agyManifestUrl, parseAgyManifest, resolveAgyInstall, type AgyInstall } from "./agy-release.js";
import { resolveClaudeInstall, type ClaudeChannel, type ClaudeInstall } from "./claude-install.js";
import { createBrewQueue, homebrewCaskApiUrl, resolveHomebrewCask } from "./homebrew.js";
import { errorMessage, isRecord } from "./internal.js";
import { childEnv, execCli, isMissingExecutable } from "./process.js";
import type { AgentProvider } from "./providers.js";

const CHECK_TIMEOUT_MS = 5_000;
// Doctor checks the whole installation, including network and database health.
const CODEX_DOCTOR_TIMEOUT_MS = 30_000;
/** Installers download and unpack a whole release, so they need far longer than
 * the read-only checks — but still a ceiling, so a wedged installer cannot pin
 * a host's update state to "running" forever. */
const APPLY_TIMEOUT_MS = 10 * 60 * 1_000;
const CLAUDE_RELEASE_BASE_URL = "https://downloads.claude.ai/claude-code-releases";
const CLAUDE_NPM_BASE_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code";
const AGY_MANIFEST_TIMEOUT_MS = 10_000;

export type ProviderUpdateProvider = AgentProvider;

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

/** Why an update never reached the installer, or died before reporting.
 * `null` only means "no category applies" — it does not imply the installer
 * ran, since an unclassified spawn failure lands here too. Use
 * `exitCode !== null` to tell whether the installer actually decided. */
export type ProviderUpdateApplyReason =
  | "cli_not_found"
  | "unsupported_installation"
  /** The install method could not be read, so it was not safe to assume the
   * updater owns this binary — distinct from knowing it does not. */
  | "install_method_unknown"
  | "timed_out"
  | null;

export interface ProviderUpdateApplyResult {
  provider: ProviderUpdateProvider;
  ok: boolean;
  /** null when no process produced one — a refusal, a spawn failure, or a kill. */
  exitCode: number | null;
  /** Combined stdout + stderr, untrimmed; the caller decides how much to keep. */
  output: string;
  /** Set for refusals and spawn/timeout failures; null for a plain nonzero exit,
   * where `output` already carries the installer's own explanation. */
  error: string | null;
  reason: ProviderUpdateApplyReason;
}

export interface ProviderUpdateService {
  check(provider: ProviderUpdateProvider): Promise<ProviderUpdateStatus>;
  checkAll(): Promise<ProviderUpdateStatus[]>;
  /** Run the provider's own updater. Never throws: every failure mode comes
   * back as a result so a host can render it. */
  apply(provider: ProviderUpdateProvider): Promise<ProviderUpdateApplyResult>;
}

export interface ProviderUpdateServiceConfig {
  claudePath?: string;
  codexPath?: string;
  agyPath?: string;
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
  /** How the Claude Code at this path was installed. `doctorOutput` is null
   * when `claude doctor` could not be run. */
  resolveClaudeInstall?: (
    executable: string,
    env: NodeJS.ProcessEnv,
    doctorOutput: string | null,
  ) => Promise<ClaudeInstall>;
  /** Whether the Codex at this path is a Homebrew cask, which brew upgrades directly. */
  resolveCodexInstall?: (executable: string, env: NodeJS.ProcessEnv) => Promise<CodexInstall>;
  /** How the agy at this path was installed. */
  resolveAgyInstall?: (executable: string, env: NodeJS.ProcessEnv) => Promise<AgyInstall>;
}

export type CodexInstall =
  | { kind: "homebrew"; cask: string; brew: string }
  | { kind: "other" };

async function defaultResolveCodexInstall(executable: string, env: NodeJS.ProcessEnv): Promise<CodexInstall> {
  const cask = await resolveHomebrewCask(executable, env);
  return cask?.cask === "codex" ? { kind: "homebrew", ...cask } : { kind: "other" };
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  version: string;
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
      // "01" and "1" differ as raw strings but are the same number; keep
      // comparing later identifiers instead of inventing an ordering.
      if (normalizedLeft === normalizedRight) continue;
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

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = timeoutMs / 1_000;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** `execFile` reports a timeout by killing the child, which leaves `code`
 * undefined and `killed` true — so it rejects rather than resolving with an
 * exit status. Some platforms surface ETIMEDOUT instead. Exceeding `maxBuffer`
 * also kills the child, so that case has to be excluded explicitly or a chatty
 * installer gets reported as having run out of time. */
function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { killed?: unknown; code?: unknown };
  if (candidate.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return false;
  return candidate.killed === true || candidate.code === "ETIMEDOUT";
}

/** Whatever a child printed before it was killed. A hung installer's last
 * lines are the most useful thing it produced — "downloading… 47%" explains a
 * ten-minute timeout that the timeout message alone cannot — so `apply`
 * recovers them instead of reporting an empty log. */
function partialOutput(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const { stdout, stderr } = error as Error & { stdout?: unknown; stderr?: unknown };
  return [stdout, stderr]
    .filter((stream): stream is string => typeof stream === "string" && stream !== "")
    .join("\n");
}

/** stdout, then stderr on a line of its own when there is any. */
function combinedOutput(stdout: string, stderr: string): string {
  return stderr ? `${stdout}\n${stderr}` : stdout;
}

/** A probe's outcome as data, for a probe whose failure matters only later. */
async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await promise };
  } catch {
    return { ok: false };
  }
}

/** A status, with what is not known left null. */
function status(
  provider: ProviderUpdateProvider,
  checkedAt: string,
  fields: Pick<ProviderUpdateStatus, "state" | "reason">
    & Partial<Pick<ProviderUpdateStatus, "installedVersion" | "latestVersion" | "channel">>,
): ProviderUpdateStatus {
  return {
    provider,
    state: fields.state,
    installedVersion: fields.installedVersion ?? null,
    latestVersion: fields.latestVersion ?? null,
    channel: fields.channel ?? null,
    checkedAt,
    reason: fields.reason,
  };
}

function unknownStatus(
  provider: ProviderUpdateProvider,
  checkedAt: string,
  reason: Exclude<ProviderUpdateReason, "cli_not_found" | null>,
  installedVersion: string | null = null,
): ProviderUpdateStatus {
  return status(provider, checkedAt, { state: "unknown", reason, installedVersion });
}

function statusFromVersions(input: {
  provider: ProviderUpdateProvider;
  installed: ParsedSemver;
  latest: ParsedSemver;
  channel: "stable" | "latest" | null;
  checkedAt: string;
}): ProviderUpdateStatus {
  return status(input.provider, input.checkedAt, {
    state: compareVersions(input.installed, input.latest) < 0
      ? "update_available"
      : "current",
    installedVersion: input.installed.version,
    latestVersion: input.latest.version,
    channel: input.channel,
    reason: null,
  });
}

/** What `codex doctor --json` says about updates: the latest version, and the
 * command `codex update` would run, which older builds don't report. */
function parseCodexDoctor(output: string): { latest: ParsedSemver | null; updateAction: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { latest: null, updateAction: null };
  }
  if (!isRecord(parsed) || !isRecord(parsed.checks)) return { latest: null, updateAction: null };
  const updateCheck = parsed.checks["updates.status"];
  if (!isRecord(updateCheck) || !isRecord(updateCheck.details)) return { latest: null, updateAction: null };
  const latest = updateCheck.details["latest version"];
  const updateAction = updateCheck.details["update action"];
  return {
    latest: typeof latest === "string" ? parseVersion(latest) : null,
    updateAction: typeof updateAction === "string" ? updateAction : null,
  };
}

/** The `version` field of a JSON document, as the npm registry and Homebrew's cask API both answer. */
function jsonVersion(text: string): ParsedSemver | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(parsed) && typeof parsed.version === "string" ? parseVersion(parsed.version) : null;
}

/** What Codex's doctor reports when it can't tell how it was installed, so `codex update` has nothing to run. */
const CODEX_UNKNOWN_UPDATE_ACTION = "manual or unknown";

export function createProviderUpdateService(
  config: ProviderUpdateServiceConfig = {},
  deps: ProviderUpdateServiceDeps = {},
): ProviderUpdateService {
  const runCommand = deps.runCommand ?? execCli;
  const fetchText = deps.fetchText ?? defaultFetchText;
  const now = deps.now ?? (() => new Date());
  const baseEnv = config.env ?? process.env;
  const claudeInstall = deps.resolveClaudeInstall ?? resolveClaudeInstall;
  const codexInstall = deps.resolveCodexInstall ?? defaultResolveCodexInstall;
  const agyInstall = deps.resolveAgyInstall ?? resolveAgyInstall;
  const brewQueue = createBrewQueue();

  /** A resolver's answer, or `fallback` when it throws or rejects. */
  async function resolved<T>(resolve: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await resolve();
    } catch {
      return fallback;
    }
  }

  /** A latest version from a URL, or null when the fetch or the parse fails. */
  async function latestFrom(
    url: string,
    parse: (text: string) => ParsedSemver | null,
    timeoutMs = CHECK_TIMEOUT_MS,
  ): Promise<ParsedSemver | null> {
    try {
      return parse(await fetchText(url, { timeoutMs }));
    } catch {
      return null;
    }
  }

  function latestClaude(
    install: Extract<ClaudeInstall, { kind: "native" | "npm" | "homebrew" }>,
    channel: ClaudeChannel,
  ): Promise<ParsedSemver | null> {
    switch (install.kind) {
      case "native":
        return latestFrom(`${CLAUDE_RELEASE_BASE_URL}/${channel}`, parseVersion);
      case "npm":
        return latestFrom(`${CLAUDE_NPM_BASE_URL}/${channel}`, jsonVersion);
      case "homebrew":
        return latestFrom(homebrewCaskApiUrl(install.cask), jsonVersion);
    }
  }

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
        return status(provider, checkedAt, { state: "not_installed", reason: "cli_not_found" });
      }
      return unknownStatus(provider, checkedAt, "check_failed");
    }
    return parseVersion(combinedOutput(command.stdout, command.stderr))
      ?? unknownStatus(provider, checkedAt, "version_unavailable");
  }

  async function checkClaude(checkedAt: string): Promise<ProviderUpdateStatus> {
    const executable = executableFor("claude");
    const env = childEnv("claude", baseEnv);
    // Independent spawns, so run them concurrently — serializing two CLI cold
    // starts roughly doubles every check's latency. The doctor result is only
    // consulted once --version confirms the CLI is installed.
    const [installed, doctorResult] = await Promise.all([
      installedVersion("claude", executable, env, checkedAt),
      settle(runCommand(executable, ["doctor"], { env, timeoutMs: CHECK_TIMEOUT_MS })),
    ]);
    if ("state" in installed) return installed;
    const doctorOutput = doctorResult.ok
      ? combinedOutput(doctorResult.value.stdout, doctorResult.value.stderr)
      : null;
    const install = await resolved<ClaudeInstall>(() => claudeInstall(executable, env, doctorOutput), { kind: "unknown" });
    if (install.kind === "unknown") {
      return unknownStatus("claude", checkedAt, "check_failed", installed.version);
    }
    // Another manager owns it; comparing it with any channel would offer an
    // update this service can't run.
    if (install.kind === "other") {
      return unknownStatus("claude", checkedAt, "unsupported_installation", installed.version);
    }
    const { channel } = install;
    if (!channel) {
      return unknownStatus("claude", checkedAt, "version_unavailable", installed.version);
    }
    const latest = await latestClaude(install, channel);
    if (!latest) {
      return {
        ...unknownStatus("claude", checkedAt, "version_unavailable", installed.version),
        channel,
      };
    }
    return statusFromVersions({
      provider: "claude",
      installed,
      latest,
      channel,
      checkedAt,
    });
  }

  async function checkCodex(checkedAt: string): Promise<ProviderUpdateStatus> {
    const executable = executableFor("codex");
    const env = childEnv("codex", baseEnv);
    const [installed, doctorResult] = await Promise.all([
      installedVersion("codex", executable, env, checkedAt),
      settle(runCommand(executable, ["doctor", "--json"], { env, timeoutMs: CODEX_DOCTOR_TIMEOUT_MS })),
    ]);
    if ("state" in installed) return installed;
    if (!doctorResult.ok) {
      return unknownStatus("codex", checkedAt, "check_failed", installed.version);
    }
    const { latest: doctorLatest, updateAction } = parseCodexDoctor(doctorResult.value.stdout);
    // `codex update` has nothing to run for an install Codex can't place.
    if (updateAction === CODEX_UNKNOWN_UPDATE_ACTION) {
      return unknownStatus("codex", checkedAt, "unsupported_installation", installed.version);
    }
    // A cask is upgraded by brew, so it is offered only the version the cask has.
    const install = await resolved<CodexInstall>(() => codexInstall(executable, env), { kind: "other" });
    const latest = install.kind === "homebrew"
      ? await latestFrom(homebrewCaskApiUrl(install.cask), jsonVersion)
      : doctorLatest;
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

  /** agy publishes one release line through its auto-updater manifest. A
   * Homebrew cask can lag that manifest, so a Homebrew install reads the cask's
   * own version instead, and is offered only what brew can install. */
  async function checkAgy(checkedAt: string): Promise<ProviderUpdateStatus> {
    const executable = executableFor("agy");
    const env = childEnv("agy", baseEnv);
    const installed = await installedVersion("agy", executable, env, checkedAt);
    if ("state" in installed) return installed;
    const install = await resolved<AgyInstall>(() => agyInstall(executable, env), { kind: "unknown" });
    // apply refuses an install it can't vouch for, so offering it an update would only fail. Windows installs can't be placed at all, so they keep the manifest comparison for their status.
    if (install.kind === "unknown" && process.platform !== "win32") {
      return unknownStatus("agy", checkedAt, "unsupported_installation", installed.version);
    }
    let latest: ParsedSemver | null = null;
    if (install.kind === "homebrew") {
      latest = await latestFrom(homebrewCaskApiUrl(install.cask), jsonVersion);
    } else {
      const url = agyManifestUrl();
      if (url) {
        latest = await latestFrom(url, (text) => {
          const version = parseAgyManifest(text);
          return version ? parseVersion(version) : null;
        }, AGY_MANIFEST_TIMEOUT_MS);
      }
    }
    if (!latest) return unknownStatus("agy", checkedAt, "version_unavailable", installed.version);
    return statusFromVersions({ provider: "agy", installed, latest, channel: null, checkedAt });
  }

  const check = async (provider: ProviderUpdateProvider): Promise<ProviderUpdateStatus> => {
    const checkedAt = now().toISOString();
    switch (provider) {
      case "claude":
        return checkClaude(checkedAt);
      case "codex":
        return checkCodex(checkedAt);
      case "agy":
        return checkAgy(checkedAt);
    }
  };

  function executableFor(provider: ProviderUpdateProvider): string {
    switch (provider) {
      case "claude":
        return config.claudePath ?? "claude";
      case "codex":
        return config.codexPath ?? "codex";
      case "agy":
        return config.agyPath ?? "agy";
    }
  }

  function refusal(
    provider: ProviderUpdateProvider,
    reason: Exclude<ProviderUpdateApplyReason, null>,
    error: string,
    output = "",
  ): ProviderUpdateApplyResult {
    return { provider, ok: false, exitCode: null, output, error, reason };
  }

  function failureFromError(
    provider: ProviderUpdateProvider,
    executable: string,
    /** The step that failed, so a timeout reports the deadline it actually
     * blew — the doctor probe and the installer run on very different clocks. */
    step: { args: string; timeoutMs: number },
    error: unknown,
  ): ProviderUpdateApplyResult {
    // A killed child has no exit status, so this is the only place its output
    // survives. Losing it here is what leaves a ten-minute timeout with nothing
    // to show but the deadline it blew.
    const output = partialOutput(error);
    if (isMissingExecutable(error)) {
      return refusal(provider, "cli_not_found", `${executable} was not found.`, output);
    }
    if (isTimeoutError(error)) {
      return refusal(
        provider,
        "timed_out",
        `${executable} ${step.args} timed out after ${formatTimeout(step.timeoutMs)}.`,
        output,
      );
    }
    return {
      provider,
      ok: false,
      exitCode: null,
      output,
      error: errorMessage(error),
      reason: null,
    };
  }

  /** Run one installer step with the long apply timeout, reporting a failure
   * under the command that actually ran. */
  async function runInstaller(
    provider: ProviderUpdateProvider,
    executable: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): Promise<ProviderUpdateApplyResult> {
    let command: ProviderUpdateCommandResult;
    try {
      command = await runCommand(executable, args, { env, timeoutMs: APPLY_TIMEOUT_MS });
    } catch (error) {
      return failureFromError(
        provider,
        executable,
        { args: args.join(" "), timeoutMs: APPLY_TIMEOUT_MS },
        error,
      );
    }
    return {
      provider,
      ok: command.exitCode === 0,
      exitCode: command.exitCode,
      output: combinedOutput(command.stdout, command.stderr),
      error: null,
      reason: null,
    };
  }

  /** Upgrade a cask with its own prefix's brew, one brew run at a time. */
  const upgradeCask = (
    provider: ProviderUpdateProvider,
    install: { cask: string; brew: string },
    env: NodeJS.ProcessEnv,
  ) => brewQueue(() => runInstaller(provider, install.brew, ["upgrade", "--cask", install.cask], env));

  /** Native and npm installs go to `claude update`, which runs npm itself for
   * npm. A cask Claude publishes is upgraded with brew, since `claude update`
   * only prints advice for one. Anything else belongs to a manager this
   * service doesn't drive, and is refused before anything runs. */
  async function applyClaude(executable: string, env: NodeJS.ProcessEnv): Promise<ProviderUpdateApplyResult> {
    let doctorOutput: string | null = null;
    let doctorError: { error: unknown } | null = null;
    try {
      const doctor = await runCommand(executable, ["doctor"], { env, timeoutMs: CHECK_TIMEOUT_MS });
      doctorOutput = combinedOutput(doctor.stdout, doctor.stderr);
    } catch (error) {
      doctorError = { error };
    }
    const install = await resolved<ClaudeInstall>(() => claudeInstall(executable, env, doctorOutput), { kind: "unknown" });
    // The transcript is kept on every refusal: when the parse fails, the
    // output that failed to parse is the one artifact that explains why.
    const output = doctorOutput ?? "";
    switch (install.kind) {
      case "unknown":
        if (doctorError) {
          return failureFromError(
            "claude",
            executable,
            { args: "doctor", timeoutMs: CHECK_TIMEOUT_MS },
            doctorError.error,
          );
        }
        // Not a fact about the install: claiming a package manager when
        // doctor was simply unreadable would send the user off to one that
        // may not own this binary at all.
        return refusal(
          "claude",
          "install_method_unknown",
          "Could not read how Claude Code was installed, so the updater was not run.",
          output,
        );
      case "other":
        return refusal(
          "claude",
          "unsupported_installation",
          install.manager === "development"
            ? "This is a development build of Claude Code, which can't be updated."
            : `Claude Code was installed with ${install.manager}; update it with that package manager.`,
          output,
        );
      case "homebrew":
        return upgradeCask("claude", install, env);
      case "native":
      case "npm":
        return runInstaller("claude", executable, ["update"], env);
    }
  }

  async function applyAgy(executable: string, env: NodeJS.ProcessEnv): Promise<ProviderUpdateApplyResult> {
    const install = await resolved<AgyInstall>(() => agyInstall(executable, env), { kind: "unknown" });
    switch (install.kind) {
      case "homebrew":
        return upgradeCask("agy", install, env);
      case "native":
        return runInstaller("agy", executable, ["update"], env);
      case "unknown":
        return refusal(
          "agy",
          "install_method_unknown",
          "Could not tell how agy was installed, so its updater was not run.",
        );
    }
  }

  /** `codex update` runs whatever its own install needs: npm, bun, pnpm or
   * the standalone installer. A cask is upgraded with the brew that owns it
   * instead, so a different brew earlier on PATH can't upgrade its own copy
   * and report success, and the brew queue holds until brew itself exits. */
  async function applyCodex(executable: string, env: NodeJS.ProcessEnv): Promise<ProviderUpdateApplyResult> {
    const install = await resolved<CodexInstall>(() => codexInstall(executable, env), { kind: "other" });
    return install.kind === "homebrew"
      ? upgradeCask("codex", install, env)
      : runInstaller("codex", executable, ["update"], env);
  }

  const apply = async (
    provider: ProviderUpdateProvider,
  ): Promise<ProviderUpdateApplyResult> => {
    const executable = executableFor(provider);
    const env = childEnv(provider, baseEnv);
    switch (provider) {
      case "claude":
        return applyClaude(executable, env);
      case "codex":
        return applyCodex(executable, env);
      case "agy":
        return applyAgy(executable, env);
    }
  };

  return {
    check,
    checkAll: () => Promise.all([
      check("claude"),
      check("codex"),
      check("agy"),
    ]),
    apply,
  };
}
