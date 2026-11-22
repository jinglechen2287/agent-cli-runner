import { describe, expect, it, vi } from "vitest";
import { agyManifestUrl } from "../src/agy-release.js";
import { classifyClaudeInstall, parseClaudeDoctor } from "../src/claude-install.js";
import {
  createProviderUpdateService,
  type ProviderUpdateCommandResult,
  type ProviderUpdateServiceDeps,
} from "../src/provider-updates.js";

const NOW = new Date("2026-07-25T12:00:00.000Z");

function result(
  stdout: string,
  options: { stderr?: string; exitCode?: number } = {},
): ProviderUpdateCommandResult {
  return {
    stdout,
    stderr: options.stderr ?? "",
    exitCode: options.exitCode ?? 0,
  };
}

function commandKey(executable: string, args: readonly string[]): string {
  return `${executable} ${args.join(" ")}`;
}

function makeDeps(
  commands: Record<string, ProviderUpdateCommandResult | Error>,
  latest: Record<string, string | Error> = {},
): ProviderUpdateServiceDeps {
  return {
    now: () => NOW,
    runCommand: vi.fn(async (executable, args) => {
      const value = commands[commandKey(executable, args)];
      if (!value) throw new Error(`Unexpected command: ${commandKey(executable, args)}`);
      if (value instanceof Error) throw value;
      return value;
    }),
    fetchText: vi.fn(async (url) => {
      const value = latest[url];
      if (!value) throw new Error(`Unexpected URL: ${url}`);
      if (value instanceof Error) throw value;
      return value;
    }),
    // The real resolvers follow the executable on this machine's PATH; these
    // read only what doctor printed, so a test never depends on the host.
    resolveClaudeInstall: claudeAt(null),
    resolveCodexInstall: vi.fn(async () => ({ kind: "other" as const })),
    resolveAgyInstall: vi.fn(async () => ({ kind: "unknown" as const })),
  };
}

/** A Claude install resolver that sees the executable at `realPath`. */
function claudeAt(realPath: string | null) {
  return vi.fn(async (_executable: string, _env: NodeJS.ProcessEnv, doctorOutput: string | null) =>
    classifyClaudeInstall(realPath, doctorOutput === null ? null : parseClaudeDoctor(doctorOutput)));
}

const CONFIG_INSTALL_METHOD: Record<string, string> = {
  native: "native",
  "npm-global": "global",
  "npm-local": "local",
};

/** `claude doctor` output. `running` null leaves out the Running line, as
 * builds before it did. */
function claudeDoctor(
  running: string | null = "native",
  channel = "latest",
  extra: { packageManager?: string; path?: string; configInstallMethod?: string } = {},
): ProviderUpdateCommandResult {
  const config = extra.configInstallMethod ?? CONFIG_INSTALL_METHOD[running ?? ""] ?? "unknown";
  return result([
    "Claude Code doctor",
    "",
    ...(running ? [`Running: ${running} (2.1.219)`] : []),
    ...(extra.packageManager ? [`Package manager: ${extra.packageManager}`] : []),
    ...(extra.path ? [`Path: ${extra.path}`] : []),
    `Config install method: ${config}`,
    "Auto-updates: enabled",
    `Auto-update channel: ${channel}`,
  ].join("\n"));
}

const commandsRun = (deps: ProviderUpdateServiceDeps) =>
  vi.mocked(deps.runCommand!).mock.calls.map(([executable, args]) => commandKey(executable, args));

function codexDoctor(
  latestVersion: string,
  exitCode = 0,
): ProviderUpdateCommandResult {
  return result(JSON.stringify({
    checks: {
      "updates.status": {
        details: {
          "latest version": latestVersion,
        },
      },
    },
  }), { exitCode });
}

describe("provider update service", () => {
  it("reports native Claude as current on its configured stable channel", async () => {
    const deps = makeDeps(
      {
        "custom-claude --version": result("2.1.212 (Claude Code)"),
        "custom-claude doctor": claudeDoctor("native", "stable"),
      },
      {
        "https://downloads.claude.ai/claude-code-releases/stable": "2.1.212\n",
      },
    );
    const service = createProviderUpdateService({ claudePath: "custom-claude" }, deps);

    await expect(service.check("claude")).resolves.toEqual({
      provider: "claude",
      state: "current",
      installedVersion: "2.1.212",
      latestVersion: "2.1.212",
      channel: "stable",
      checkedAt: NOW.toISOString(),
      reason: null,
    });
    expect(deps.fetchText).toHaveBeenCalledWith(
      "https://downloads.claude.ai/claude-code-releases/stable",
      { timeoutMs: 5_000 },
    );
  });

  it("reports a native Claude update from the latest channel", async () => {
    const deps = makeDeps(
      {
        "claude --version": result("2.1.219 (Claude Code)"),
        "claude doctor": claudeDoctor("native", "latest"),
      },
      {
        "https://downloads.claude.ai/claude-code-releases/latest": "2.1.220",
      },
    );

    await expect(
      createProviderUpdateService({}, deps).check("claude"),
    ).resolves.toMatchObject({
      state: "update_available",
      installedVersion: "2.1.219",
      latestVersion: "2.1.220",
      channel: "latest",
      reason: null,
    });
  });

  it("does not compare a Claude another package manager owns with any channel", async () => {
    const deps = makeDeps({
      "claude --version": result("2.1.219 (Claude Code)"),
      "claude doctor": claudeDoctor("package-manager", "latest", { packageManager: "winget" }),
    });

    await expect(
      createProviderUpdateService({}, deps).check("claude"),
    ).resolves.toMatchObject({
      state: "unknown",
      installedVersion: "2.1.219",
      latestVersion: null,
      channel: null,
      reason: "unsupported_installation",
    });
    expect(deps.fetchText).not.toHaveBeenCalled();
  });

  it("uses SemVer prerelease ordering", async () => {
    const deps = makeDeps(
      {
        "claude --version": result("2.1.220-beta.1 (Claude Code)"),
        "claude doctor": claudeDoctor(),
      },
      {
        "https://downloads.claude.ai/claude-code-releases/latest": "2.1.220",
      },
    );

    await expect(
      createProviderUpdateService({}, deps).check("claude"),
    ).resolves.toMatchObject({
      state: "update_available",
      installedVersion: "2.1.220-beta.1",
      latestVersion: "2.1.220",
    });
  });

  it("compares arbitrarily large numeric SemVer prerelease identifiers", async () => {
    const deps = makeDeps(
      {
        "claude --version": result("2.1.220-beta.9007199254740992 (Claude Code)"),
        "claude doctor": claudeDoctor(),
      },
      {
        "https://downloads.claude.ai/claude-code-releases/latest":
          "2.1.220-beta.9007199254740993",
      },
    );

    await expect(
      createProviderUpdateService({}, deps).check("claude"),
    ).resolves.toMatchObject({
      state: "update_available",
      installedVersion: "2.1.220-beta.9007199254740992",
      latestVersion: "2.1.220-beta.9007199254740993",
    });
  });

  it("reports Codex update state from doctor JSON despite a nonzero doctor exit", async () => {
    const deps = makeDeps({
      "/opt/codex --version": result("codex-cli 0.144.6"),
      "/opt/codex doctor --json": codexDoctor("0.145.0", 1),
    });
    const service = createProviderUpdateService({ codexPath: "/opt/codex" }, deps);

    await expect(service.check("codex")).resolves.toEqual({
      provider: "codex",
      state: "update_available",
      installedVersion: "0.144.6",
      latestVersion: "0.145.0",
      channel: null,
      checkedAt: NOW.toISOString(),
      reason: null,
    });
  });

  it("reports Codex as current when it is not older than the latest version", async () => {
    const deps = makeDeps({
      "codex --version": result("codex-cli 0.145.0"),
      "codex doctor --json": codexDoctor("0.145.0"),
    });

    await expect(
      createProviderUpdateService({}, deps).check("codex"),
    ).resolves.toMatchObject({
      state: "current",
      installedVersion: "0.145.0",
      latestVersion: "0.145.0",
      reason: null,
    });
  });

  it("returns not_installed when the version command is missing", async () => {
    const missing = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const deps = makeDeps({
      "claude --version": missing,
    });

    await expect(
      createProviderUpdateService({}, deps).check("claude"),
    ).resolves.toMatchObject({
      state: "not_installed",
      installedVersion: null,
      latestVersion: null,
      reason: "cli_not_found",
    });
  });

  it.each([
    {
      name: "a command timeout",
      commands: {
        "claude --version": result("2.1.219 (Claude Code)"),
        "claude doctor": Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      },
      latest: {},
      reason: "check_failed",
    },
    {
      name: "malformed installed-version output",
      commands: {
        "claude --version": result("Claude Code development build"),
      },
      latest: {},
      reason: "version_unavailable",
    },
    {
      name: "an unavailable latest version",
      commands: {
        "claude --version": result("2.1.219 (Claude Code)"),
        "claude doctor": claudeDoctor(),
      },
      latest: {
        "https://downloads.claude.ai/claude-code-releases/latest": new Error("offline"),
      },
      reason: "version_unavailable",
    },
    {
      name: "older Codex doctor output without update metadata",
      commands: {
        "codex --version": result("codex-cli 0.100.0"),
        "codex doctor --json": result(JSON.stringify({ checks: {} })),
      },
      latest: {},
      reason: "version_unavailable",
    },
  ])("returns an unknown result for $name", async ({ commands, latest, reason }) => {
    const provider = Object.keys(commands)[0]?.startsWith("codex") ? "codex" : "claude";
    const deps = makeDeps(commands, latest);

    await expect(
      createProviderUpdateService({}, deps).check(provider),
    ).resolves.toMatchObject({
      provider,
      state: "unknown",
      latestVersion: null,
      reason,
    });
  });

  it("checks every provider independently when one fails", async () => {
    const deps = makeDeps({
      "claude --version": new Error("Claude probe failed"),
      "codex --version": result("codex-cli 0.145.0"),
      "codex doctor --json": codexDoctor("0.145.0"),
    });

    const statuses = await createProviderUpdateService({}, deps).checkAll();

    expect(statuses).toHaveLength(3);
    expect(statuses[0]).toMatchObject({
      provider: "claude",
      state: "unknown",
      reason: "check_failed",
    });
    expect(statuses[1]).toMatchObject({
      provider: "codex",
      state: "current",
    });
    expect(statuses[2]).toMatchObject({ provider: "agy", state: "unknown", reason: "check_failed" });
  });

  it("applies a Codex update with the long installer timeout", async () => {
    const deps = makeDeps({
      "codex update": result("Updated codex to 0.145.1", { stderr: "downloading" }),
    });
    const service = createProviderUpdateService({}, deps);

    await expect(service.apply("codex")).resolves.toEqual({
      provider: "codex",
      ok: true,
      exitCode: 0,
      output: "Updated codex to 0.145.1\ndownloading",
      error: null,
      reason: null,
    });
    expect(deps.runCommand).toHaveBeenCalledWith("codex", ["update"], {
      timeoutMs: 600_000,
      env: expect.anything(),
    });
  });

  it("applies a Claude update only after doctor confirms a native install", async () => {
    const deps = makeDeps({
      "claude doctor": claudeDoctor("native", "latest"),
      "claude update": result("Updated to 2.1.220"),
    });

    await expect(
      createProviderUpdateService({}, deps).apply("claude"),
    ).resolves.toMatchObject({ ok: true, exitCode: 0, reason: null });
    expect(deps.runCommand).toHaveBeenCalledWith("claude", ["doctor"], {
      timeoutMs: 5_000,
      env: expect.anything(),
    });
  });

  it.each(["winget", "apk", "mise", "asdf"])(
    "refuses to run any installer for a Claude install %s owns",
    async (manager) => {
      const deps = makeDeps({ "claude doctor": claudeDoctor("package-manager", "stable", { packageManager: manager }) });

      const refused = await createProviderUpdateService({}, deps).apply("claude");
      expect(refused).toMatchObject({
        provider: "claude",
        ok: false,
        exitCode: null,
        reason: "unsupported_installation",
      });
      // Naming the manager is the whole point: it tells the user where to go.
      expect(refused.error).toContain(manager);
      expect(commandsRun(deps)).toEqual(["claude doctor"]);
    },
  );

  it("refuses to update a development build", async () => {
    const deps = makeDeps({ "claude doctor": claudeDoctor("development") });

    await expect(createProviderUpdateService({}, deps).apply("claude")).resolves.toMatchObject({
      ok: false,
      reason: "unsupported_installation",
    });
    expect(commandsRun(deps)).toEqual(["claude doctor"]);
  });

  it("refuses without claiming a package manager when doctor cannot be parsed", async () => {
    const deps = makeDeps({ "claude doctor": result("Claude Code doctor") });

    await expect(
      createProviderUpdateService({}, deps).apply("claude"),
    ).resolves.toMatchObject({
      ok: false,
      reason: "install_method_unknown",
      error: "Could not read how Claude Code was installed, so the updater was not run.",
    });
    expect(deps.runCommand).not.toHaveBeenCalledWith(
      "claude",
      ["update"],
      expect.anything(),
    );
  });

  it("preserves a nonzero installer exit without treating it as a refusal", async () => {
    const deps = makeDeps({
      "codex update": result("", { stderr: "network unreachable", exitCode: 1 }),
    });

    await expect(
      createProviderUpdateService({}, deps).apply("codex"),
    ).resolves.toEqual({
      provider: "codex",
      ok: false,
      exitCode: 1,
      output: "\nnetwork unreachable",
      error: null,
      reason: null,
    });
  });

  it("reports a missing CLI rather than a failed install", async () => {
    const deps = makeDeps({
      "codex update": Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    });

    await expect(
      createProviderUpdateService({}, deps).apply("codex"),
    ).resolves.toMatchObject({
      ok: false,
      exitCode: null,
      reason: "cli_not_found",
      error: "codex was not found.",
    });
  });

  it("reports an installer killed by the timeout", async () => {
    const deps = makeDeps({
      "codex update": Object.assign(new Error("Command failed"), {
        killed: true,
        signal: "SIGTERM",
      }),
    });

    await expect(
      createProviderUpdateService({}, deps).apply("codex"),
    ).resolves.toMatchObject({
      ok: false,
      exitCode: null,
      reason: "timed_out",
      error: "codex update timed out after 10 minutes.",
    });
  });

  it("does not mistake a maxBuffer overflow for a timeout", async () => {
    const deps = makeDeps({
      "codex update": Object.assign(new Error("stdout maxBuffer length exceeded"), {
        killed: true,
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }),
    });

    await expect(
      createProviderUpdateService({}, deps).apply("codex"),
    ).resolves.toMatchObject({
      ok: false,
      reason: null,
      error: "stdout maxBuffer length exceeded",
    });
  });

  it("keeps what a killed installer printed before it died", async () => {
    // The deadline alone explains nothing; the last lines are the diagnosis.
    const deps = makeDeps({
      "codex update": Object.assign(new Error("Command failed"), {
        killed: true,
        signal: "SIGTERM",
        stdout: "downloading 0.145.1... 47%",
        stderr: "warning: slow mirror",
      }),
    });

    await expect(
      createProviderUpdateService({}, deps).apply("codex"),
    ).resolves.toMatchObject({
      ok: false,
      reason: "timed_out",
      output: "downloading 0.145.1... 47%\nwarning: slow mirror",
    });
  });

  it("keeps the output an overflowing installer produced", async () => {
    const deps = makeDeps({
      "codex update": Object.assign(new Error("stdout maxBuffer length exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        killed: true,
        stdout: "installing...",
        stderr: "",
      }),
    });

    await expect(
      createProviderUpdateService({}, deps).apply("codex"),
    ).resolves.toMatchObject({
      ok: false,
      // The fixture is killed with a signal like a timeout is, so pinning the
      // reason is the point: this must not be blamed on the deadline.
      reason: null,
      output: "installing...",
    });
  });

  it("reports a missing CLI without inventing output", async () => {
    const deps = makeDeps({
      "codex update": Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    });

    await expect(
      createProviderUpdateService({}, deps).apply("codex"),
    ).resolves.toMatchObject({ ok: false, reason: "cli_not_found", output: "" });
  });

  it("reports the doctor probe's own deadline, not the installer's", async () => {
    const deps = makeDeps({
      "claude doctor": Object.assign(new Error("Command failed"), {
        killed: true,
        signal: "SIGTERM",
      }),
    });

    await expect(
      createProviderUpdateService({}, deps).apply("claude"),
    ).resolves.toMatchObject({
      ok: false,
      reason: "timed_out",
      error: "claude doctor timed out after 5 seconds.",
    });
  });

  it("honours configured executable paths when applying updates", async () => {
    const deps = makeDeps({
      "/opt/codex update": result("done"),
      "custom-claude doctor": claudeDoctor("native"),
      "custom-claude update": result("done"),
    });
    const service = createProviderUpdateService(
      { claudePath: "custom-claude", codexPath: "/opt/codex" },
      deps,
    );

    await expect(service.apply("codex")).resolves.toMatchObject({ ok: true });
    await expect(service.apply("claude")).resolves.toMatchObject({ ok: true });
  });

  it("strips provider nesting guards from the installer environment", async () => {
    const deps = makeDeps({ "codex update": result("done") });
    const service = createProviderUpdateService({
      env: {
        PATH: "/usr/bin",
        CODEX_THREAD_ID: "parent-thread",
        CLAUDECODE: "1",
      },
    }, deps);

    await service.apply("codex");

    expect(deps.runCommand).toHaveBeenCalledWith("codex", ["update"], {
      timeoutMs: 600_000,
      env: { PATH: "/usr/bin", CLAUDECODE: "1" },
    });
  });

  it("uses five-second checks and strips provider nesting guards", async () => {
    const deps = makeDeps({
      "claude --version": result("2.1.219 (Claude Code)"),
      "claude doctor": claudeDoctor("package-manager", "latest", { packageManager: "mise" }),
      "codex --version": result("codex-cli 0.145.0"),
      "codex doctor --json": codexDoctor("0.145.0"),
    });
    const service = createProviderUpdateService({
      env: {
        PATH: "/usr/bin",
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "parent",
        CLAUDE_CODE_SESSION_ACCESS_TOKEN: "secret",
        CODEX_THREAD_ID: "parent-thread",
      },
    }, deps);

    await service.checkAll();

    expect(deps.runCommand).toHaveBeenCalledWith("claude", ["--version"], {
      timeoutMs: 5_000,
      env: {
        PATH: "/usr/bin",
        CODEX_THREAD_ID: "parent-thread",
      },
    });
    expect(deps.runCommand).toHaveBeenCalledWith("codex", ["--version"], {
      timeoutMs: 5_000,
      env: {
        PATH: "/usr/bin",
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "parent",
        CLAUDE_CODE_SESSION_ACCESS_TOKEN: "secret",
      },
    });
  });

  it("gives Codex doctor thirty seconds, since it checks the whole installation", async () => {
    const deps = makeDeps({
      "codex --version": result("codex-cli 0.145.0"),
      "codex doctor --json": codexDoctor("0.145.0"),
    });

    await createProviderUpdateService({ env: { PATH: "/usr/bin" } }, deps).check("codex");

    expect(deps.runCommand).toHaveBeenCalledWith("codex", ["doctor", "--json"], {
      timeoutMs: 30_000,
      env: { PATH: "/usr/bin" },
    });
  });
});

describe("provider update service regressions", () => {
  it("treats numerically-equal prerelease identifiers with leading zeros as equal", async () => {
    const deps = makeDeps(
      {
        "claude --version": result("2.1.220-beta.01 (Claude Code)"),
        "claude doctor": claudeDoctor("native", "latest"),
      },
      {
        // beta.01 == beta.1, and the extra .5 identifier makes latest newer.
        "https://downloads.claude.ai/claude-code-releases/latest": "2.1.220-beta.1.5\n",
      },
    );

    await expect(
      createProviderUpdateService({}, deps).check("claude"),
    ).resolves.toMatchObject({
      state: "update_available",
      installedVersion: "2.1.220-beta.01",
      latestVersion: "2.1.220-beta.1.5",
    });
  });

  it("keeps the unparseable doctor transcript on an install_method_unknown refusal", async () => {
    const deps = makeDeps({ "claude doctor": result("Claude Code doctor\nsomething new") });

    await expect(
      createProviderUpdateService({}, deps).apply("claude"),
    ).resolves.toMatchObject({
      reason: "install_method_unknown",
      // The transcript that failed to parse is the one artifact that
      // explains the refusal — it must not be dropped.
      output: "Claude Code doctor\nsomething new",
    });
  });

  it("keeps the doctor transcript on an unsupported_installation refusal", async () => {
    const deps = makeDeps({ "claude doctor": claudeDoctor("package-manager", "latest", { packageManager: "mise" }) });

    await expect(
      createProviderUpdateService({}, deps).apply("claude"),
    ).resolves.toMatchObject({
      reason: "unsupported_installation",
      output: expect.stringContaining("Package manager: mise"),
    });
  });
});

describe("agy updates", () => {
  const manifest = (version: string, overrides: Record<string, unknown> = {}) => JSON.stringify({
    version,
    url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-5999302598852608/darwin-arm/cli_mac_arm64.tar.gz`,
    sha512: "a".repeat(128),
    ...overrides,
  });
  const manifestUrl = agyManifestUrl()!;
  const install = (kind: "native" | "homebrew" | "unknown") => vi.fn(async () => kind === "homebrew"
    ? { kind, cask: "antigravity-cli", brew: "/opt/homebrew/bin/brew" }
    : { kind });
  const caskUrl = "https://formulae.brew.sh/api/cask/antigravity-cli.json";
  const cask = (version: string) => JSON.stringify({ token: "antigravity-cli", version });

  it("reports an update from the auto-updater manifest on an official install", async () => {
    const deps = { ...makeDeps({ "agy --version": result("1.5.13") }, { [manifestUrl]: manifest("1.5.14") }), resolveAgyInstall: install("native") };
    await expect(createProviderUpdateService({}, deps).check("agy")).resolves.toEqual({
      provider: "agy",
      state: "update_available",
      installedVersion: "1.5.13",
      latestVersion: "1.5.14",
      channel: null,
      checkedAt: NOW.toISOString(),
      reason: null,
    });
    expect(deps.fetchText).toHaveBeenCalledWith(manifestUrl, { timeoutMs: 10_000 });
  });

  it("reports a Homebrew update from the cask, not the manifest", async () => {
    const deps = {
      ...makeDeps({ "agy --version": result("1.5.13") }, { [caskUrl]: cask("1.5.14,5302690847260672") }),
      resolveAgyInstall: install("homebrew"),
    };
    await expect(createProviderUpdateService({}, deps).check("agy")).resolves.toMatchObject({
      state: "update_available", installedVersion: "1.5.13", latestVersion: "1.5.14", reason: null,
    });
    expect(vi.mocked(deps.fetchText!).mock.calls.map(([url]) => url)).toEqual([caskUrl]);
  });

  it("calls a Homebrew agy current while the cask has not caught up with the manifest", async () => {
    const deps = {
      ...makeDeps({ "agy --version": result("1.5.14") }, { [caskUrl]: cask("1.5.14,5302690847260672"), [manifestUrl]: manifest("1.5.15") }),
      resolveAgyInstall: install("homebrew"),
    };
    await expect(createProviderUpdateService({}, deps).check("agy")).resolves.toMatchObject({
      state: "current", installedVersion: "1.5.14", latestVersion: "1.5.14",
    });
    expect(vi.mocked(deps.fetchText!).mock.calls.map(([url]) => url)).toEqual([caskUrl]);
  });

  it("answers version_unavailable for a bad manifest or a failed fetch", async () => {
    for (const latest of [
      manifest("1.5.14", { url: "https://evil.example/agy.tar.gz" }),
      manifest("1.5.14", { sha512: "nope" }),
      new Error("offline"),
    ]) {
      const deps = { ...makeDeps({ "agy --version": result("1.5.13") }, { [manifestUrl]: latest }), resolveAgyInstall: install("native") };
      await expect(createProviderUpdateService({}, deps).check("agy")).resolves.toMatchObject({
        state: "unknown", reason: "version_unavailable",
      });
    }
  });

  it("reports a failing agy --version like the other providers", async () => {
    const deps = { ...makeDeps({ "agy --version": new Error("boom") }), resolveAgyInstall: install("native") };
    await expect(createProviderUpdateService({}, deps).check("agy")).resolves.toMatchObject({
      state: "unknown", reason: "check_failed",
    });
    const missing = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
    const absent = { ...makeDeps({ "agy --version": missing }), resolveAgyInstall: install("native") };
    await expect(createProviderUpdateService({}, absent).check("agy")).resolves.toMatchObject({
      state: "not_installed", reason: "cli_not_found",
    });
  });

  it("runs agy update on an official install and brew on a Homebrew one", async () => {
    const native = { ...makeDeps({ "agy update": result("Updated to 1.5.14") }), resolveAgyInstall: install("native") };
    await expect(createProviderUpdateService({}, native).apply("agy")).resolves.toMatchObject({
      provider: "agy", ok: true, exitCode: 0, output: "Updated to 1.5.14",
    });
    expect(native.runCommand).toHaveBeenCalledWith("agy", ["update"], expect.objectContaining({ timeoutMs: 600_000 }));

    const brew = {
      ...makeDeps({ "/opt/homebrew/bin/brew upgrade --cask antigravity-cli": result("==> Upgrading antigravity-cli") }),
      resolveAgyInstall: install("homebrew"),
    };
    await expect(createProviderUpdateService({}, brew).apply("agy")).resolves.toMatchObject({
      provider: "agy", ok: true, exitCode: 0, output: "==> Upgrading antigravity-cli",
    });
    expect(brew.runCommand).toHaveBeenCalledWith(
      "/opt/homebrew/bin/brew",
      ["upgrade", "--cask", "antigravity-cli"],
      expect.objectContaining({ timeoutMs: 600_000 }),
    );

    const unknown = { ...makeDeps({}), resolveAgyInstall: install("unknown") };
    await expect(createProviderUpdateService({}, unknown).apply("agy")).resolves.toMatchObject({
      ok: false, reason: "install_method_unknown",
    });
    expect(unknown.runCommand).not.toHaveBeenCalled();
  });
});

describe("Claude installed through npm", () => {
  it("checks the npm dist-tag for the doctor's channel", async () => {
    const deps = makeDeps(
      {
        "claude --version": result("2.1.219 (Claude Code)"),
        "claude doctor": claudeDoctor("npm-global", "latest"),
      },
      {
        "https://registry.npmjs.org/@anthropic-ai/claude-code/latest": JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.220" }),
      },
    );

    await expect(createProviderUpdateService({}, deps).check("claude")).resolves.toMatchObject({
      state: "update_available",
      installedVersion: "2.1.219",
      latestVersion: "2.1.220",
      channel: "latest",
      reason: null,
    });
  });

  it("lets claude update run npm itself", async () => {
    const deps = makeDeps({
      "claude doctor": claudeDoctor("npm-local"),
      "claude update": result("Successfully updated"),
    });

    await expect(createProviderUpdateService({}, deps).apply("claude")).resolves.toMatchObject({ ok: true, exitCode: 0 });
    expect(commandsRun(deps)).toEqual(["claude doctor", "claude update"]);
  });

  it("treats an older build's global config install method as npm", async () => {
    const deps = makeDeps(
      {
        "claude --version": result("2.1.100 (Claude Code)"),
        "claude doctor": claudeDoctor(null, "stable", { configInstallMethod: "global" }),
      },
      { "https://registry.npmjs.org/@anthropic-ai/claude-code/stable": JSON.stringify({ version: "2.1.100" }) },
    );

    await expect(createProviderUpdateService({}, deps).check("claude")).resolves.toMatchObject({
      state: "current",
      channel: "stable",
    });
  });

  it.each([
    {
      manager: "bun",
      realPath: "/Users/u/.bun/install/global/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      path: undefined,
    },
    {
      manager: "pnpm",
      realPath: "/Users/u/Library/pnpm/claude",
      path: "/Users/u/Library/pnpm/global/5/.pnpm/@anthropic-ai+claude-code@2.1.219/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
    },
  ])("refuses a $manager global install that doctor reports as npm-global", async ({ manager, realPath, path }) => {
    const doctor = claudeDoctor("npm-global", "latest", path ? { path } : {});
    const checking = { ...makeDeps({ "claude --version": result("2.1.219 (Claude Code)"), "claude doctor": doctor }), resolveClaudeInstall: claudeAt(realPath) };
    await expect(createProviderUpdateService({}, checking).check("claude")).resolves.toMatchObject({
      state: "unknown",
      reason: "unsupported_installation",
      installedVersion: "2.1.219",
    });
    expect(checking.fetchText).not.toHaveBeenCalled();

    const applying = { ...makeDeps({ "claude doctor": doctor }), resolveClaudeInstall: claudeAt(realPath) };
    const refused = await createProviderUpdateService({}, applying).apply("claude");
    expect(refused).toMatchObject({ ok: false, reason: "unsupported_installation" });
    expect(refused.error).toContain(manager);
    expect(commandsRun(applying)).toEqual(["claude doctor"]);
  });
});

describe("Claude installed through Homebrew", () => {
  const brewDoctor = claudeDoctor("package-manager", "latest", { packageManager: "homebrew" });

  it("checks the claude-code cask on the stable channel", async () => {
    const deps = {
      ...makeDeps(
        { "claude --version": result("2.1.320 (Claude Code)"), "claude doctor": brewDoctor },
        { "https://formulae.brew.sh/api/cask/claude-code.json": JSON.stringify({ token: "claude-code", version: "2.1.323" }) },
      ),
      resolveClaudeInstall: claudeAt("/opt/homebrew/Caskroom/claude-code/2.1.320/claude"),
    };

    await expect(createProviderUpdateService({}, deps).check("claude")).resolves.toMatchObject({
      state: "update_available",
      installedVersion: "2.1.320",
      latestVersion: "2.1.323",
      channel: "stable",
      reason: null,
    });
  });

  it("upgrades the cask with that prefix's brew", async () => {
    const deps = {
      ...makeDeps({
        "claude doctor": brewDoctor,
        "/opt/homebrew/bin/brew upgrade --cask claude-code": result("==> Upgrading 1 outdated package"),
      }),
      resolveClaudeInstall: claudeAt("/opt/homebrew/Caskroom/claude-code/2.1.320/claude"),
    };

    await expect(createProviderUpdateService({}, deps).apply("claude")).resolves.toMatchObject({ ok: true, exitCode: 0 });
    expect(deps.runCommand).toHaveBeenCalledWith(
      "/opt/homebrew/bin/brew",
      ["upgrade", "--cask", "claude-code"],
      expect.objectContaining({ timeoutMs: 600_000 }),
    );
    expect(commandsRun(deps)).toEqual(["claude doctor", "/opt/homebrew/bin/brew upgrade --cask claude-code"]);
  });

  it("checks and upgrades claude-code@latest on the latest channel", async () => {
    const realPath = "/opt/homebrew/Caskroom/claude-code@latest/2.1.330/claude";
    const checking = {
      ...makeDeps(
        { "claude --version": result("2.1.330 (Claude Code)"), "claude doctor": claudeDoctor("package-manager", "stable", { packageManager: "homebrew" }) },
        { "https://formulae.brew.sh/api/cask/claude-code@latest.json": JSON.stringify({ version: "2.1.330" }) },
      ),
      resolveClaudeInstall: claudeAt(realPath),
    };
    await expect(createProviderUpdateService({}, checking).check("claude")).resolves.toMatchObject({
      state: "current",
      channel: "latest",
    });

    const applying = {
      ...makeDeps({ "claude doctor": brewDoctor, "/opt/homebrew/bin/brew upgrade --cask claude-code@latest": result("") }),
      resolveClaudeInstall: claudeAt(realPath),
    };
    await createProviderUpdateService({}, applying).apply("claude");
    expect(commandsRun(applying)).toContain("/opt/homebrew/bin/brew upgrade --cask claude-code@latest");
  });

  it("still upgrades the cask when doctor itself fails", async () => {
    const deps = {
      ...makeDeps({
        "claude doctor": new Error("doctor crashed"),
        "/opt/homebrew/bin/brew upgrade --cask claude-code": result("done"),
      }),
      resolveClaudeInstall: claudeAt("/opt/homebrew/Caskroom/claude-code/2.1.320/claude"),
    };

    await expect(createProviderUpdateService({}, deps).apply("claude")).resolves.toMatchObject({ ok: true });
  });

  it("reports a missing brew as brew, not as claude", async () => {
    const deps = {
      ...makeDeps({
        "claude doctor": brewDoctor,
        "/opt/homebrew/bin/brew upgrade --cask claude-code": Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
      }),
      resolveClaudeInstall: claudeAt("/opt/homebrew/Caskroom/claude-code/2.1.320/claude"),
    };

    const failed = await createProviderUpdateService({}, deps).apply("claude");
    expect(failed).toMatchObject({ ok: false, exitCode: null, reason: "cli_not_found" });
    expect(failed.error).toContain("/opt/homebrew/bin/brew");
  });

  it("names the brew step and keeps what brew printed when it runs out of time", async () => {
    const deps = {
      ...makeDeps({
        "claude doctor": brewDoctor,
        "/opt/homebrew/bin/brew upgrade --cask claude-code": Object.assign(new Error("Command failed"), {
          killed: true,
          signal: "SIGTERM",
          stdout: "==> Downloading claude-code 47%",
        }),
      }),
      resolveClaudeInstall: claudeAt("/opt/homebrew/Caskroom/claude-code/2.1.320/claude"),
    };

    const failed = await createProviderUpdateService({}, deps).apply("claude");
    expect(failed).toMatchObject({ ok: false, reason: "timed_out", output: "==> Downloading claude-code 47%" });
    expect(failed.error).toContain("brew upgrade --cask claude-code");
    expect(failed.error).toContain("10 minutes");
  });
});

describe("Codex update actions", () => {
  const doctorWith = (updateAction: string) => result(JSON.stringify({
    checks: { "updates.status": { details: { "latest version": "0.171.0", "update action": updateAction } } },
  }));

  it("offers no update when Codex can't tell how it was installed", async () => {
    const deps = makeDeps({
      "codex --version": result("codex-cli 0.144.3"),
      "codex doctor --json": doctorWith("manual or unknown"),
    });

    await expect(createProviderUpdateService({}, deps).check("codex")).resolves.toMatchObject({
      state: "unknown",
      reason: "unsupported_installation",
      installedVersion: "0.144.3",
    });
  });

  it.each(["npm install -g @openai/codex", "bun install -g @openai/codex", "brew upgrade --cask codex", "standalone installer"])(
    "offers the update when Codex updates itself with %s",
    async (updateAction) => {
      const deps = makeDeps({
        "codex --version": result("codex-cli 0.144.3"),
        "codex doctor --json": doctorWith(updateAction),
      });

      await expect(createProviderUpdateService({}, deps).check("codex")).resolves.toMatchObject({
        state: "update_available",
        latestVersion: "0.171.0",
      });
    },
  );
});

describe("Homebrew updates run one at a time", () => {
  it("starts each brew run only after the one before it finishes", async () => {
    const events: string[] = [];
    const pending = new Map<string, () => void>();
    const deps: ProviderUpdateServiceDeps = {
      ...makeDeps({}),
      runCommand: vi.fn(async (executable: string, args: readonly string[]) => {
        const key = commandKey(executable, args);
        if (key === "claude doctor") return claudeDoctor("package-manager", "latest", { packageManager: "homebrew" });
        events.push(`start ${key}`);
        await new Promise<void>((resolve) => pending.set(key, resolve));
        events.push(`end ${key}`);
        return result("done");
      }),
      resolveClaudeInstall: claudeAt("/opt/homebrew/Caskroom/claude-code/2.1.320/claude"),
      resolveCodexInstall: vi.fn(async () => ({ kind: "homebrew" as const, cask: "codex", brew: "/opt/homebrew/bin/brew" })),
      resolveAgyInstall: vi.fn(async () => ({ kind: "homebrew" as const, cask: "antigravity-cli", brew: "/opt/homebrew/bin/brew" })),
    };
    const service = createProviderUpdateService({}, deps);

    const runs = Promise.all([service.apply("claude"), service.apply("codex"), service.apply("agy")]);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    for (let step = 0; step < 3; step += 1) {
      await settle();
      // Exactly one run is in flight at every step: the next waits for it.
      expect(pending.size).toBe(1);
      const [key, finish] = [...pending.entries()][0]!;
      pending.delete(key);
      finish();
    }
    const results = await runs;

    expect(results.every((outcome) => outcome.ok)).toBe(true);
    expect(events.map((event) => event.split(" ")[0])).toEqual(["start", "end", "start", "end", "start", "end"]);
    expect(new Set(events.map((event) => event.replace(/^(start|end) /, "")))).toEqual(new Set([
      "/opt/homebrew/bin/brew upgrade --cask claude-code",
      "/opt/homebrew/bin/brew upgrade --cask codex",
      "/opt/homebrew/bin/brew upgrade --cask antigravity-cli",
    ]));
  });
});

/** Run `body` as if on `platform`, for behaviour that differs on Windows. */
async function onPlatform(platform: NodeJS.Platform, body: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    await body();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("review follow-ups", () => {
  it("offers no update for an agy whose install it can't vouch for, since apply would refuse it", async () => {
    await onPlatform("darwin", async () => {
      const deps = makeDeps({ "agy --version": result("1.5.13") });

      await expect(createProviderUpdateService({}, deps).check("agy")).resolves.toMatchObject({
        state: "unknown",
        reason: "unsupported_installation",
        installedVersion: "1.5.13",
      });
    });
  });

  it("upgrades a Homebrew Codex with the brew that owns its cask, not whichever brew is on PATH", async () => {
    const deps = {
      ...makeDeps({ "/usr/local/bin/brew upgrade --cask codex": result("==> Upgrading codex") }),
      resolveCodexInstall: vi.fn(async () => ({ kind: "homebrew" as const, cask: "codex", brew: "/usr/local/bin/brew" })),
    };

    await expect(createProviderUpdateService({}, deps).apply("codex")).resolves.toMatchObject({ ok: true, exitCode: 0 });
    expect(commandsRun(deps)).toEqual(["/usr/local/bin/brew upgrade --cask codex"]);
  });

  it("treats a resolver that throws outright like one that rejects", async () => {
    const boom = () => {
      throw new Error("resolver exploded");
    };
    const deps: ProviderUpdateServiceDeps = {
      ...makeDeps({
        "claude --version": result("2.1.219 (Claude Code)"),
        "claude doctor": claudeDoctor(),
        "codex update": result("done"),
      }),
      resolveClaudeInstall: boom,
      resolveCodexInstall: boom,
      resolveAgyInstall: boom,
    };
    const service = createProviderUpdateService({}, deps);

    await expect(service.check("claude")).resolves.toMatchObject({ state: "unknown", reason: "check_failed" });
    await expect(service.apply("claude")).resolves.toMatchObject({ ok: false, reason: "install_method_unknown" });
    await expect(service.apply("codex")).resolves.toMatchObject({ ok: true });
    await expect(service.apply("agy")).resolves.toMatchObject({ ok: false, reason: "install_method_unknown" });
  });

  it("checks a Homebrew Codex against the cask, so it is offered only what brew can install", async () => {
    const deps = {
      ...makeDeps(
        {
          "codex --version": result("codex-cli 0.170.0"),
          "codex doctor --json": codexDoctor("0.171.0"),
        },
        { "https://formulae.brew.sh/api/cask/codex.json": JSON.stringify({ version: "0.170.0" }) },
      ),
      resolveCodexInstall: vi.fn(async () => ({ kind: "homebrew" as const, cask: "codex", brew: "/opt/homebrew/bin/brew" })),
    };

    await expect(createProviderUpdateService({}, deps).check("codex")).resolves.toMatchObject({
      state: "current",
      installedVersion: "0.170.0",
      latestVersion: "0.170.0",
    });
  });

  it("keeps comparing agy with its manifest on Windows, where the install can't be placed", async () => {
    await onPlatform("win32", async () => {
      const url = agyManifestUrl()!;
      const deps = makeDeps({ "agy --version": result("1.5.14") }, {
        [url]: JSON.stringify({
          version: "1.5.14",
          url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-1/windows/agy.zip",
          sha512: "a".repeat(128),
        }),
      });
      await expect(createProviderUpdateService({}, deps).check("agy")).resolves.toMatchObject({ state: "current" });
    });
  });
});
