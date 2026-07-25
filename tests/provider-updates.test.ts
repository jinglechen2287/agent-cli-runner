import { describe, expect, it, vi } from "vitest";
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
  };
}

function claudeDoctor(
  installMethod = "native",
  channel = "latest",
): ProviderUpdateCommandResult {
  return result(`
Claude Code doctor

Running: native (2.1.219)
Config install method: ${installMethod}
Auto-updates: enabled
Auto-update channel: ${channel}
  `);
}

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

  it("does not compare non-native Claude installations with native channels", async () => {
    const deps = makeDeps({
      "claude --version": result("2.1.219 (Claude Code)"),
      "claude doctor": claudeDoctor("homebrew", "latest"),
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

  it("checks both providers independently when one fails", async () => {
    const deps = makeDeps({
      "claude --version": new Error("Claude probe failed"),
      "codex --version": result("codex-cli 0.145.0"),
      "codex doctor --json": codexDoctor("0.145.0"),
    });

    const statuses = await createProviderUpdateService({}, deps).checkAll();

    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({
      provider: "claude",
      state: "unknown",
      reason: "check_failed",
    });
    expect(statuses[1]).toMatchObject({
      provider: "codex",
      state: "current",
    });
  });

  it("uses five-second checks and strips provider nesting guards", async () => {
    const deps = makeDeps({
      "claude --version": result("2.1.219 (Claude Code)"),
      "claude doctor": claudeDoctor("homebrew"),
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
});
