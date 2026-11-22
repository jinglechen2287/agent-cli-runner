/**
 * How Claude Code was installed, from where its binary really lives and what
 * `claude doctor` says. The path wins where it is telling: Claude's own
 * detection calls a bun, pnpm or yarn global install `npm-global`, and `claude
 * update` would then run npm and leave that copy untouched.
 */
import { homebrewCaskAt, resolveRealPath } from "./homebrew.js";

export type ClaudeChannel = "stable" | "latest";

export type ClaudeInstall =
  /** The native installer. `claude update` updates it. */
  | { kind: "native"; channel: ClaudeChannel | null }
  /** A global or local npm install. `claude update` runs npm itself. */
  | { kind: "npm"; channel: ClaudeChannel | null }
  /** A cask Claude publishes. Its channel is the cask's, not doctor's. */
  | { kind: "homebrew"; cask: string; brew: string; channel: ClaudeChannel }
  /** Something only its own manager can update. */
  | { kind: "other"; manager: string }
  | { kind: "unknown" };

export interface ClaudeDoctor {
  /** The installation type doctor reports as running, e.g. `native`, `npm-global`, `package-manager`. */
  running: string | null;
  packageManager: string | null;
  path: string | null;
  invoked: string | null;
  configInstallMethod: string | null;
  channel: ClaudeChannel | null;
}

/** The casks Claude publishes, and the channel each follows. */
const CLAUDE_CASKS: Record<string, ClaudeChannel> = {
  "claude-code": "stable",
  "claude-code@latest": "latest",
};

function line(output: string, label: string): string | null {
  const match = output.match(new RegExp(`^${label}:[ \\t]*(.+?)[ \\t]*$`, "im"));
  return match?.[1] ?? null;
}

/** What doctor says about the install, or null when it names none. */
export function parseClaudeDoctor(output: string): ClaudeDoctor | null {
  const running = line(output, "Running")?.split(/\s/)[0]?.toLowerCase() ?? null;
  const configInstallMethod = line(output, "Config install method")?.split(/\s/)[0]?.toLowerCase() ?? null;
  if (!running && !configInstallMethod) return null;
  const rawChannel = line(output, "Auto-update channel")?.toLowerCase();
  return {
    running,
    packageManager: line(output, "Package manager"),
    path: line(output, "Path"),
    invoked: line(output, "Invoked"),
    configInstallMethod,
    channel: rawChannel === "stable" || rawChannel === "latest" ? rawChannel : null,
  };
}

/** The global package directories of managers `claude update` doesn't drive. */
function globalPackageManager(path: string): string | null {
  // Windows paths from doctor use backslashes, and Yarn's Windows folder is capitalised.
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/.bun/install/global/")) return "bun";
  if (normalized.includes("/.pnpm/") || normalized.includes("/pnpm/global/")) return "pnpm";
  if (normalized.includes("/yarn/global/") || normalized.includes("/yarn/data/global/")) return "yarn";
  return null;
}

/** How Claude Code was installed, given the executable's real path and doctor's report. */
export function classifyClaudeInstall(realPath: string | null, doctor: ClaudeDoctor | null): ClaudeInstall {
  const paths = [realPath, doctor?.path, doctor?.invoked].filter((path): path is string => Boolean(path));
  for (const path of paths) {
    const cask = homebrewCaskAt(path);
    if (!cask) continue;
    const channel = CLAUDE_CASKS[cask.cask];
    return channel ? { kind: "homebrew", ...cask, channel } : { kind: "other", manager: "homebrew" };
  }
  for (const path of paths) {
    const manager = globalPackageManager(path);
    if (manager) return { kind: "other", manager };
  }
  if (!doctor) return { kind: "unknown" };
  const { channel } = doctor;
  switch (doctor.running) {
    case "native":
      return { kind: "native", channel };
    case "npm-global":
    case "npm-local":
      return { kind: "npm", channel };
    case "package-manager":
      return { kind: "other", manager: doctor.packageManager ?? "a package manager" };
    case "development":
      return { kind: "other", manager: "development" };
    case null:
      break;
    default:
      return { kind: "unknown" };
  }
  // Builds before the Running line said only what the config recorded.
  switch (doctor.configInstallMethod) {
    case "native":
      return { kind: "native", channel };
    case "global":
    case "local":
      return { kind: "npm", channel };
    default:
      return { kind: "unknown" };
  }
}

/** How the Claude Code on PATH was installed. `doctorOutput` is null when doctor couldn't be run. */
export async function resolveClaudeInstall(
  executable: string,
  env: NodeJS.ProcessEnv,
  doctorOutput: string | null,
): Promise<ClaudeInstall> {
  const realPath = await resolveRealPath(executable, env);
  return classifyClaudeInstall(realPath, doctorOutput === null ? null : parseClaudeDoctor(doctorOutput));
}
