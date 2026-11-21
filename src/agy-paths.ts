/**
 * Where agy keeps a session's files, and safe ways to reach them. The step-log
 * reader, the subagent reader and isolated-run cleanup all build their paths
 * here, so a session id can never lead outside agy's data root.
 */
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** agy's default `--app-data-dir`, beneath the gemini dir. */
export const AGY_DEFAULT_APP_DATA_DIR = "antigravity-cli";

export interface AgyDataRootOptions {
  /** agy's `--gemini-dir`. */
  geminiDir?: string | undefined;
  /** agy's `--app-data-dir`, which agy joins beneath the gemini dir. */
  appDataDir?: string | undefined;
  /** The child's environment: its GEMINI_HOME and HOME decide the default. */
  env: NodeJS.ProcessEnv;
}

/** The gemini dir agy uses: `geminiDir`, else GEMINI_HOME, else ~/.gemini. */
export function agyGeminiDir(options: Omit<AgyDataRootOptions, "appDataDir">): string {
  if (options.geminiDir) return options.geminiDir;
  const { env } = options;
  if (env.GEMINI_HOME) return env.GEMINI_HOME;
  return join(env.HOME ?? env.USERPROFILE ?? homedir(), ".gemini");
}

/** The directory holding agy's `conversations/`, `brain/` and `annotations/`. */
export function agyDataRoot(options: AgyDataRootOptions): string {
  return join(agyGeminiDir(options), options.appDataDir ?? AGY_DEFAULT_APP_DATA_DIR);
}

/** A session, conversation or message id agy generates: word characters and
 * dashes only, so it can be a path segment without climbing anywhere. */
export function isAgyId(id: string): boolean {
  return /^[\w-]+$/.test(id);
}

const SAFE_SEGMENT = /^[\w.-]+$/;

/** `root` joined with `segments`, when that path exists and no segment below
 * the root is a symbolic link. Segments must be plain names: no separators,
 * no `.` or `..`. Anything else answers undefined. */
export async function literalPath(root: string, segments: readonly string[]): Promise<string | undefined> {
  let path = root;
  for (const segment of segments) {
    if (!SAFE_SEGMENT.test(segment) || segment === "." || segment === "..") return undefined;
    path = join(path, segment);
    try {
      if ((await lstat(path)).isSymbolicLink()) return undefined;
    } catch {
      return undefined;
    }
  }
  return path;
}
