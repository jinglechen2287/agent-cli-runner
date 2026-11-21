import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { antigravityCliTarget, parseAgyManifest, resolveAgyInstall } from "../src/agy-release.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function executable(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
}

describe("antigravityCliTarget", () => {
  it("names the auto-updater's targets", () => {
    expect(antigravityCliTarget("darwin", "arm64")).toBe("darwin_arm64");
    expect(antigravityCliTarget("linux", "x64", true)).toBe("linux_amd64_musl");
    expect(antigravityCliTarget("win32", "x64")).toBe("windows_amd64");
    expect(antigravityCliTarget("freebsd", "x64")).toBeNull();
  });
});

describe("parseAgyManifest", () => {
  it("accepts only a manifest pointing at Google's release bucket", () => {
    const url = "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-1/darwin-arm/cli_mac_arm64.tar.gz";
    expect(parseAgyManifest(JSON.stringify({ version: "1.5.13", url, sha512: "f".repeat(128) }))).toBe("1.5.13");
    expect(parseAgyManifest(JSON.stringify({ version: "1.5.14", url, sha512: "f".repeat(128) }))).toBeNull();
    expect(parseAgyManifest("not json")).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("resolveAgyInstall", () => {
  it("tells Homebrew, the official installer and anything else apart", async () => {
    const root = mkdtempSync(join(tmpdir(), "agy-install-"));
    dirs.push(root);
    const cask = join(root, "Caskroom", "antigravity-cli", "1.5.13,1", ".homebrew-command-wrappers", "agy");
    executable(cask);
    mkdirSync(join(root, "brew-bin"));
    symlinkSync(cask, join(root, "brew-bin", "agy"));
    expect(await resolveAgyInstall("agy", { PATH: join(root, "brew-bin"), HOME: root })).toBe("homebrew");

    executable(join(root, ".local", "bin", "agy"));
    expect(await resolveAgyInstall("agy", { PATH: join(root, ".local", "bin"), HOME: root })).toBe("native");

    executable(join(root, ".local", "tools", "agy"));
    expect(await resolveAgyInstall("agy", { PATH: join(root, ".local", "tools"), HOME: root })).toBe("unknown");

    executable(join(root, "elsewhere", "agy"));
    expect(await resolveAgyInstall("agy", { PATH: join(root, "elsewhere"), HOME: root })).toBe("unknown");
    expect(await resolveAgyInstall("agy", { PATH: join(root, "nothing"), HOME: root })).toBe("unknown");
  });
});
