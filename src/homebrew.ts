/**
 * Homebrew casks: which cask a CLI came from, where Homebrew publishes the
 * cask's version, and a queue that keeps two `brew` runs from overlapping.
 */
import { realpath } from "node:fs/promises";
import { resolveExecutable } from "./process.js";

/** A cask, and the brew of the Homebrew prefix it is installed under. */
export interface HomebrewCask {
  cask: string;
  /** `<prefix>/bin/brew`, so a host whose PATH lacks Homebrew can still run it. */
  brew: string;
}

/** The cask a real path sits under (`<prefix>/Caskroom/<cask>/<version>/...`), or null outside any Caskroom. */
export function homebrewCaskAt(path: string): HomebrewCask | null {
  const match = path.match(/^(.+)\/Caskroom\/([^/]+)\/[^/]+\//);
  if (!match) return null;
  return { cask: match[2]!, brew: `${match[1]}/bin/brew` };
}

/** Where an executable really lives once PATH and symlinks are followed, or null when it can't be found. */
export async function resolveRealPath(executable: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (process.platform === "win32") return null;
  const found = resolveExecutable(executable, env);
  if (!found) return null;
  return realpath(found).catch(() => null);
}

/** The cask the executable on PATH came from, or null when Homebrew didn't install it. */
export async function resolveHomebrewCask(executable: string, env: NodeJS.ProcessEnv): Promise<HomebrewCask | null> {
  const real = await resolveRealPath(executable, env);
  return real ? homebrewCaskAt(real) : null;
}

/** The cask's entry in the API brew itself reads, so its version is one `brew upgrade` can install. */
export function homebrewCaskApiUrl(cask: string): string {
  return `https://formulae.brew.sh/api/cask/${cask}.json`;
}

/** Runs tasks one at a time, each after the one before it settles. Two
 * `brew upgrade` runs at once contend for brew's lock, so every brew run a
 * service starts goes through one of these. */
export function createBrewQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
