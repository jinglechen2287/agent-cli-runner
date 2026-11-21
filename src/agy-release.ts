/**
 * Where agy's releases are published and how it was installed. The manifest
 * and its validation follow T3 Code's antigravityCliRelease: the auto-updater
 * agy itself uses publishes `{version, url, sha512}` per platform.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { isRecord } from "./internal.js";
import { resolveExecutable } from "./process.js";

export const AGY_MANIFEST_BASE =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const RELEASE_URL_PREFIX = "https://storage.googleapis.com/antigravity-public/antigravity-cli/";

/** The auto-updater's name for a platform, e.g. `darwin_arm64`. */
export function antigravityCliTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl = false,
): string | null {
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) return null;
  const os = platform === "win32" ? "windows" : platform;
  return `${os}_${arch === "x64" ? "amd64" : arch}${platform === "linux" && musl ? "_musl" : ""}`;
}

/** Whether this Linux runs on musl rather than glibc. */
function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

/** The manifest URL for this machine, or null on a platform agy doesn't ship. */
export function agyManifestUrl(): string | null {
  const target = antigravityCliTarget(process.platform, process.arch, isMusl());
  return target ? `${AGY_MANIFEST_BASE}/${target}.json` : null;
}

/** The version a manifest names, when the manifest is well formed and points
 * at Google's release bucket. */
export function parseAgyManifest(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { version, url, sha512 } = value;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  if (typeof url !== "string" || !url.startsWith(`${RELEASE_URL_PREFIX}${version}-`)) return null;
  if (typeof sha512 !== "string" || !/^[a-fA-F0-9]{128}$/.test(sha512)) return null;
  return version;
}

export type AgyInstallMethod = "native" | "homebrew" | "unknown";

/** How the agy on PATH was installed: Homebrew's cask, the official
 * installer (`~/.local/bin/agy`), or something this library can't vouch for. */
export async function resolveAgyInstall(executable: string, env: NodeJS.ProcessEnv): Promise<AgyInstallMethod> {
  if (process.platform === "win32") return "unknown";
  const found = resolveExecutable(executable, env);
  if (!found) return "unknown";
  let real: string;
  try {
    real = await realpath(found);
  } catch {
    return "unknown";
  }
  if (real.includes(`${sep}Caskroom${sep}antigravity-cli${sep}`)) return "homebrew";
  // The official installer writes the binary itself to ~/.local/bin/agy;
  // its --dir option puts it somewhere this library can't vouch for. Compare
  // resolved folders: on macOS a home under /var is really /private/var.
  const home = env.HOME ?? homedir();
  const binDir = await realpath(join(home, ".local", "bin")).catch(() => undefined);
  if (binDir && basename(real) === "agy" && dirname(real) === binDir) return "native";
  return "unknown";
}
