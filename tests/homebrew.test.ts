import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBrewQueue, homebrewCaskApiUrl, homebrewCaskAt, resolveHomebrewCask } from "../src/homebrew.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("homebrewCaskAt", () => {
  it("reads the cask and the brew of an Apple silicon prefix", () => {
    expect(homebrewCaskAt("/opt/homebrew/Caskroom/claude-code/2.1.323/claude")).toEqual({
      cask: "claude-code",
      brew: "/opt/homebrew/bin/brew",
    });
  });

  it("reads an Intel prefix, where bin/brew is a symlink into the Homebrew repository", () => {
    expect(homebrewCaskAt("/usr/local/Caskroom/antigravity-cli/1.5.14,5302690847260672/.homebrew-command-wrappers/agy")).toEqual({
      cask: "antigravity-cli",
      brew: "/usr/local/bin/brew",
    });
  });

  it("keeps a cask name with an @ in it", () => {
    expect(homebrewCaskAt("/opt/homebrew/Caskroom/claude-code@latest/2.1.330/claude")?.cask).toBe("claude-code@latest");
  });

  it("answers null for a path outside any Caskroom", () => {
    expect(homebrewCaskAt("/Users/u/.local/share/claude/versions/2.1.330")).toBeNull();
    expect(homebrewCaskAt("/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js")).toBeNull();
  });
});

describe("homebrewCaskApiUrl", () => {
  it("points at the cask API brew itself reads", () => {
    expect(homebrewCaskApiUrl("claude-code@latest")).toBe("https://formulae.brew.sh/api/cask/claude-code@latest.json");
  });
});

describe.skipIf(process.platform === "win32")("resolveHomebrewCask", () => {
  it("follows the PATH symlink into the Caskroom", async () => {
    const root = mkdtempSync(join(tmpdir(), "brew-cask-"));
    dirs.push(root);
    const real = join(root, "Caskroom", "claude-code", "2.1.323", "claude");
    mkdirSync(join(real, ".."), { recursive: true });
    writeFileSync(real, "#!/bin/sh\n");
    chmodSync(real, 0o755);
    mkdirSync(join(root, "bin"));
    symlinkSync(real, join(root, "bin", "claude"));

    const found = await resolveHomebrewCask("claude", { PATH: join(root, "bin") });
    expect(found?.cask).toBe("claude-code");
    expect(found?.brew.endsWith("/bin/brew")).toBe(true);
    expect(await resolveHomebrewCask("claude", { PATH: join(root, "nothing") })).toBeNull();
  });
});

describe("createBrewQueue", () => {
  it("starts each task only after the one before it settles, failed or not", async () => {
    const queue = createBrewQueue();
    const events: string[] = [];
    let finishFirst!: () => void;
    const first = queue(() => new Promise<void>((resolve) => {
      events.push("first started");
      finishFirst = () => {
        events.push("first finished");
        resolve();
      };
    }));
    const second = queue(async () => {
      events.push("second started");
      throw new Error("brew failed");
    });
    const third = queue(async () => {
      events.push("third started");
      return 3;
    });

    await Promise.resolve();
    expect(events).toEqual(["first started"]);
    finishFirst();
    await first;
    await expect(second).rejects.toThrow("brew failed");
    await expect(third).resolves.toBe(3);
    expect(events).toEqual(["first started", "first finished", "second started", "third started"]);
  });
});
