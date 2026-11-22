import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyClaudeInstall, parseClaudeDoctor, resolveClaudeInstall } from "../src/claude-install.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function doctor(lines: string[]): string {
  return ["Claude Code doctor", "", ...lines, "Search: OK (bundled)"].join("\n");
}

const nativeDoctor = doctor([
  "Running: native (2.1.330)",
  "Path: /Users/u/.local/share/claude/versions/2.1.330",
  "Config install method: native",
  "Auto-updates: enabled",
  "Auto-update channel: latest",
]);

describe("parseClaudeDoctor", () => {
  it("reads what doctor says about the install", () => {
    expect(parseClaudeDoctor(doctor([
      "Running: package-manager (2.1.323)",
      "Package manager: winget",
      "Path: C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\claude.exe",
      "Invoked: C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe",
      "Config install method: unknown",
      "Auto-updates: Managed by package manager",
      "Auto-update channel: stable",
    ]))).toEqual({
      running: "package-manager",
      packageManager: "winget",
      path: "C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\claude.exe",
      invoked: "C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe",
      configInstallMethod: "unknown",
      channel: "stable",
    });
  });

  it("answers null when doctor names no install at all", () => {
    expect(parseClaudeDoctor("Claude Code doctor\nsomething new")).toBeNull();
  });
});

describe("classifyClaudeInstall", () => {
  const parsed = (text: string) => parseClaudeDoctor(text);

  it("trusts doctor for a native install", () => {
    expect(classifyClaudeInstall("/Users/u/.local/share/claude/versions/2.1.330", parsed(nativeDoctor))).toEqual({
      kind: "native",
      channel: "latest",
    });
  });

  it.each(["npm-global", "npm-local"])("treats Running: %s as npm", (running) => {
    expect(classifyClaudeInstall(
      "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      parsed(doctor([`Running: ${running} (2.1.330)`, "Auto-update channel: stable"])),
    )).toEqual({ kind: "npm", channel: "stable" });
  });

  it("reads a claude-code cask from the real path, on the stable channel whatever doctor says", () => {
    expect(classifyClaudeInstall(
      "/opt/homebrew/Caskroom/claude-code/2.1.320/claude",
      parsed(doctor(["Running: package-manager (2.1.320)", "Package manager: homebrew", "Auto-update channel: latest"])),
    )).toEqual({ kind: "homebrew", cask: "claude-code", brew: "/opt/homebrew/bin/brew", channel: "stable" });
  });

  it("puts the claude-code@latest cask on the latest channel", () => {
    expect(classifyClaudeInstall("/opt/homebrew/Caskroom/claude-code@latest/2.1.330/claude", null)).toEqual({
      kind: "homebrew",
      cask: "claude-code@latest",
      brew: "/opt/homebrew/bin/brew",
      channel: "latest",
    });
  });

  it("finds the cask from doctor's Path line when the executable's own path doesn't show it", () => {
    expect(classifyClaudeInstall(null, parsed(doctor([
      "Running: package-manager (2.1.323)",
      "Package manager: homebrew",
      "Path: /usr/local/Caskroom/claude-code/2.1.323/claude",
    ])))).toMatchObject({ kind: "homebrew", cask: "claude-code", brew: "/usr/local/bin/brew" });
  });

  it("refuses a cask outside the ones Claude publishes", () => {
    expect(classifyClaudeInstall("/opt/homebrew/Caskroom/someones-claude/1.0.0/claude", parsed(nativeDoctor))).toEqual({
      kind: "other",
      manager: "homebrew",
    });
  });

  it("names bun for a bun global install that doctor calls npm-global", () => {
    expect(classifyClaudeInstall(
      "/Users/u/.bun/install/global/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      parsed(doctor(["Running: npm-global (2.1.330)", "Auto-update channel: latest"])),
    )).toEqual({ kind: "other", manager: "bun" });
  });

  it("names pnpm when doctor's Path is in pnpm's store behind a shell shim", () => {
    expect(classifyClaudeInstall("/Users/u/Library/pnpm/claude", parsed(doctor([
      "Running: npm-global (2.1.330)",
      "Path: /Users/u/Library/pnpm/global/5/.pnpm/@anthropic-ai+claude-code@2.1.330/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      "Auto-update channel: latest",
    ])))).toEqual({ kind: "other", manager: "pnpm" });
  });

  it("names yarn for a yarn global install", () => {
    expect(classifyClaudeInstall(
      "/Users/u/.config/yarn/global/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      parsed(doctor(["Running: npm-global (2.1.330)"])),
    )).toEqual({ kind: "other", manager: "yarn" });
  });

  it("names yarn for a Windows yarn global install", () => {
    expect(classifyClaudeInstall(null, parsed(doctor([
      "Running: npm-global (2.1.330)",
      "Path: C:\\Users\\u\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    ])))).toEqual({ kind: "other", manager: "yarn" });
  });

  it("reads a Windows bun path from doctor", () => {
    expect(classifyClaudeInstall(null, parsed(doctor([
      "Running: npm-global (2.1.330)",
      "Path: C:\\Users\\u\\.bun\\install\\global\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    ])))).toEqual({ kind: "other", manager: "bun" });
  });

  it.each(["winget", "apk", "mise", "asdf"])("names %s for a package-manager install", (manager) => {
    expect(classifyClaudeInstall(null, parsed(doctor([
      "Running: package-manager (2.1.323)",
      `Package manager: ${manager}`,
    ])))).toEqual({ kind: "other", manager });
  });

  it("treats a development build as one it can't update", () => {
    expect(classifyClaudeInstall(null, parsed(doctor(["Running: development (2.1.330)"])))).toEqual({
      kind: "other",
      manager: "development",
    });
  });

  it("falls back to the config install method on builds without a Running line", () => {
    expect(classifyClaudeInstall(null, parsed(doctor(["Config install method: global", "Auto-update channel: stable"])))).toEqual({
      kind: "npm",
      channel: "stable",
    });
    expect(classifyClaudeInstall(null, parsed(doctor(["Config install method: native", "Auto-update channel: latest"])))).toEqual({
      kind: "native",
      channel: "latest",
    });
    expect(classifyClaudeInstall(null, parsed(doctor(["Config install method: unknown"])))).toEqual({ kind: "unknown" });
  });

  it("knows nothing without a readable doctor or a telling path", () => {
    expect(classifyClaudeInstall(null, null)).toEqual({ kind: "unknown" });
    expect(classifyClaudeInstall("/usr/bin/claude", null)).toEqual({ kind: "unknown" });
    expect(classifyClaudeInstall(null, parsed(doctor(["Running: unknown (2.1.330)"])))).toEqual({ kind: "unknown" });
  });
});

describe.skipIf(process.platform === "win32")("resolveClaudeInstall", () => {
  it("follows the executable on PATH to its real path", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-install-"));
    dirs.push(root);
    const real = join(root, "Caskroom", "claude-code@latest", "2.1.330", "claude");
    mkdirSync(join(real, ".."), { recursive: true });
    writeFileSync(real, "#!/bin/sh\n");
    chmodSync(real, 0o755);
    mkdirSync(join(root, "bin"));
    symlinkSync(real, join(root, "bin", "claude"));

    await expect(resolveClaudeInstall("claude", { PATH: join(root, "bin") }, null)).resolves.toMatchObject({
      kind: "homebrew",
      cask: "claude-code@latest",
      channel: "latest",
    });
    await expect(resolveClaudeInstall("claude", { PATH: join(root, "nothing") }, nativeDoctor)).resolves.toEqual({
      kind: "native",
      channel: "latest",
    });
  });
});
