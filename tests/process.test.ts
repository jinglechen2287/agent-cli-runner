import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MissingCliError } from "../src/errors.js";
import { createDeferred } from "../src/internal.js";
import {
  createLineSplitter,
  execCli,
  killTreeOnKill,
  launchCommand,
  resolveExecutable,
  spawnCli,
  terminateTree,
} from "../src/process.js";

function makeDir(files: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "resolve-exe-"));
  for (const file of files) writeFileSync(join(dir, file), "");
  return dir;
}

describe("resolveExecutable on Windows", () => {
  it("finds a PATHEXT match and skips an extensionless script beside it", () => {
    const dir = makeDir(["codex", "codex.cmd"]);
    expect(resolveExecutable("codex", { PATH: dir, PATHEXT: ".EXE;.CMD" }, { platform: "win32" }))
      .toBe(join(dir, "codex.cmd"));
  });

  it("reads Path and PATHEXT whatever their case", () => {
    const dir = makeDir(["codex.cmd"]);
    expect(resolveExecutable("codex", { Path: dir, PathExt: ".cmd" }, { platform: "win32" }))
      .toBe(join(dir, "codex.cmd"));
  });

  it("searches directories in PATH order, then extensions in PATHEXT order", () => {
    const first = makeDir(["codex.cmd"]);
    const second = makeDir(["codex.exe"]);
    const both = makeDir(["codex.cmd", "codex.exe"]);
    const env = { PATHEXT: ".EXE;.CMD" };
    expect(resolveExecutable("codex", { ...env, PATH: `${first};${second}` }, { platform: "win32" }))
      .toBe(join(first, "codex.cmd"));
    expect(resolveExecutable("codex", { ...env, PATH: both }, { platform: "win32" }))
      .toBe(join(both, "codex.exe"));
  });

  it("falls back to the default PATHEXT when the env sets none", () => {
    const dir = makeDir(["codex.cmd"]);
    expect(resolveExecutable("codex", { PATH: dir }, { platform: "win32" })).toBe(join(dir, "codex.cmd"));
  });

  it("takes a name that already has an extension as it is", () => {
    const dir = makeDir(["cli.js"]);
    expect(resolveExecutable("cli.js", { PATH: dir }, { platform: "win32" })).toBe(join(dir, "cli.js"));
  });

  it("checks a path in place, adding PATHEXT extensions", () => {
    const dir = makeDir(["codex.cmd"]);
    expect(resolveExecutable(join(dir, "codex"), { PATH: "" }, { platform: "win32" }))
      .toBe(join(dir, "codex.cmd"));
  });

  it("returns undefined when nothing matches", () => {
    const dir = makeDir(["codex"]);
    expect(resolveExecutable("codex", { PATH: dir }, { platform: "win32" })).toBeUndefined();
    expect(resolveExecutable(join(dir, "missing"), { PATH: dir }, { platform: "win32" })).toBeUndefined();
  });

  it("resolves a relative path and relative PATH entries against cwd", () => {
    const cwd = makeDir([]);
    mkdirSync(join(cwd, "bin"));
    writeFileSync(join(cwd, "bin", "codex.cmd"), "");
    const options = { platform: "win32" as const, cwd };
    expect(resolveExecutable(join("bin", "codex"), { PATH: "" }, options))
      .toBe(join(cwd, "bin", "codex.cmd"));
    expect(resolveExecutable("codex", { PATH: "bin" }, options)).toBe(join(cwd, "bin", "codex.cmd"));
  });

  it("accepts quoted PATH entries, as Windows does", () => {
    const dir = makeDir(["codex.exe"]);
    expect(resolveExecutable("codex", { PATH: `"${dir}"` }, { platform: "win32" }))
      .toBe(join(dir, "codex.exe"));
  });

  it("ignores directories named like the executable", () => {
    const dir = makeDir([]);
    mkdirSync(join(dir, "codex.exe"));
    expect(resolveExecutable("codex", { PATH: dir }, { platform: "win32" })).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("resolveExecutable off Windows", () => {
  it("resolves a relative path and relative PATH entries against cwd", () => {
    const cwd = makeDir([]);
    mkdirSync(join(cwd, "bin"));
    writeFileSync(join(cwd, "bin", "claude"), "#!/bin/sh\n");
    chmodSync(join(cwd, "bin", "claude"), 0o755);
    expect(resolveExecutable("bin/claude", { PATH: "" }, { cwd })).toBe(join(cwd, "bin", "claude"));
    expect(resolveExecutable("claude", { PATH: "bin" }, { cwd })).toBe(join(cwd, "bin", "claude"));
  });
});

describe("launchCommand", () => {
  it("leaves the command alone off Windows", () => {
    expect(launchCommand("codex", ["a b"], { PATH: "" }, { platform: "linux" }))
      .toEqual({ command: "codex", args: ["a b"], options: {} });
  });

  it("runs a resolved Windows binary directly", () => {
    const dir = makeDir(["codex.exe"]);
    expect(launchCommand("codex", ["app-server"], { PATH: dir }, { platform: "win32" }))
      .toEqual({ command: join(dir, "codex.exe"), args: ["app-server"], options: {} });
  });

  it("leaves an unresolved Windows name for spawn to report missing", () => {
    expect(launchCommand("codex", ["x"], { PATH: "" }, { platform: "win32" }))
      .toEqual({ command: "codex", args: ["x"], options: {} });
  });

  it("routes a Windows batch file through cmd.exe with verbatim arguments", () => {
    const dir = makeDir(["codex.cmd"]);
    const launch = launchCommand("codex", ["app-server"], { PATH: dir, ComSpec: "C:\\cmd.exe" }, { platform: "win32" });
    expect(launch.command).toBe("C:\\cmd.exe");
    expect(launch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(launch.args).toHaveLength(4);
    expect(launch.options).toEqual({ windowsVerbatimArguments: true });
  });

  it("refuses a line break that cmd.exe would cut the command at", () => {
    const dir = makeDir(["codex.cmd"]);
    expect(() => launchCommand("codex", ["a\nb"], { PATH: dir }, { platform: "win32" })).toThrow();
  });

  it.runIf(process.platform === "win32")(
    "passes tricky arguments through an npm-style shim intact",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "shim with space-"));
      writeFileSync(join(dir, "echo.js"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
      writeFileSync(join(dir, "echo-args.cmd"), '@node "%~dp0echo.js" %*\r\n');
      const args = [
        "plain",
        "with space",
        'x"y&z',
        "a&b|c<d>e",
        "100%",
        "%PATH%",
        "trailing\\",
        'back\\"slash',
        "^caret",
        "!bang",
        "(paren)",
        "",
      ];
      const launch = launchCommand("echo-args", args, { PATH: dir }, { platform: "win32" });
      const output = execFileSync(launch.command, launch.args, {
        ...launch.options,
        encoding: "utf8",
        env: process.env,
      });
      expect(JSON.parse(output)).toEqual(args);
    },
  );

  it.runIf(process.platform === "win32")(
    "force-kills the program a batch file started when execFile times out",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "shim-kill-"));
      const pidFile = join(dir, "pid");
      writeFileSync(
        join(dir, "hang.js"),
        `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n`
          + "setInterval(() => {}, 1000);\n",
      );
      writeFileSync(join(dir, "hang.cmd"), '@node "%~dp0hang.js" %*\r\n');
      const launch = launchCommand("hang", [], { PATH: dir }, { platform: "win32" });
      const error = await new Promise<Error | null>((resolve) => {
        const child = execFile(
          launch.command,
          launch.args,
          // execFile's default SIGTERM: its kills never escalate, so they must force.
          { ...launch.options, timeout: 3_000 },
          (err) => resolve(err),
        );
        killTreeOnKill(child);
      });
      expect(error).toMatchObject({ killed: true });
      const pid = Number(readFileSync(pidFile, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(() => process.kill(pid, 0)).toThrow();
    },
    15_000,
  );
});

describe("createLineSplitter", () => {
  it("joins a line, and a character, split across chunks", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    const bytes = Buffer.from("h\u00e9llo\nwor");
    // The cut falls inside the two bytes of "\u00e9".
    splitter.push(bytes.subarray(0, 2));
    splitter.push(bytes.subarray(2));
    splitter.push("ld\nlast");
    expect(lines).toEqual(["h\u00e9llo", "world"]);
    splitter.flush();
    expect(lines).toEqual(["h\u00e9llo", "world", "last"]);
  });

  it("reads a chunk that arrives while it hands over a line in the same pass", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => {
      lines.push(line);
      if (line === "b") splitter.push("c\n");
    });
    splitter.push("a\nb\n");
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("emits every line of one chunk, in order", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push("a\n\nb\nc\n");
    splitter.flush();
    expect(lines).toEqual(["a", "", "b", "c"]);
  });
});

describe("terminateTree", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends SIGTERM at once and SIGKILL after the grace period, then gives up", async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    let done = false;
    void terminateTree(kill, createDeferred(), { graceMs: 100 }).then(() => {
      done = true;
    });
    expect(kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(100);
    expect(kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(true);
  });

  it("resolves when the process exits, and escalates no further", async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const exited = createDeferred();
    const stopping = terminateTree(kill, exited, { graceMs: 100 });
    exited.resolve();
    await stopping;
    await vi.advanceTimersByTimeAsync(500);
    expect(kill.mock.calls).toEqual([["SIGTERM"]]);
  });

  it("still gives up when a signal cannot be sent", async () => {
    vi.useFakeTimers();
    const kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") throw new Error("kill ESRCH");
    });
    let done = false;
    void terminateTree(kill, createDeferred(), { graceMs: 100 }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
  });

  it("stops the SIGKILL for an exit seen in the same tick as its timer", () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const exited = createDeferred();
    void terminateTree(kill, exited, { graceMs: 100 });
    exited.resolve();
    vi.advanceTimersByTime(100);
    expect(kill.mock.calls).toEqual([["SIGTERM"]]);
  });
});

describe("spawnCli", () => {
  it("spawns with piped stdio, in the given cwd and env, as a group leader off Windows", () => {
    const child = {};
    const spawnFn = vi.fn(() => child);
    const spawned = spawnCli({
      cli: "codex",
      spawnFn: spawnFn as never,
      command: process.execPath,
      args: ["--version"],
      cwd: "/tmp",
      env: { PATH: "/usr/bin" },
    });
    expect(spawned).toBe(child);
    expect(spawnFn).toHaveBeenCalledWith(process.execPath, ["--version"], expect.objectContaining({
      cwd: "/tmp",
      env: { PATH: "/usr/bin" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    }));
  });

  it("reports a binary the spawn could not find as a missing CLI", () => {
    const spawnFn = () => {
      throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    };
    expect(() => spawnCli({
      cli: "codex",
      spawnFn: spawnFn as never,
      command: "codex",
      args: [],
      cwd: "/tmp",
      env: {},
    })).toThrow(MissingCliError);
  });
});

describe("execCli", () => {
  it("resolves with the output and exit code of a command that fails", async () => {
    await expect(execCli(
      process.execPath,
      ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3"],
      { env: process.env, timeoutMs: 10_000 },
    )).resolves.toEqual({ stdout: "out", stderr: "err", exitCode: 3 });
  });

  it("rejects a command it killed, carrying what it printed first", async () => {
    await expect(execCli(
      process.execPath,
      ["-e", "process.stdout.write('partial'); setInterval(() => {}, 1000)"],
      { env: process.env, timeoutMs: 500 },
    )).rejects.toMatchObject({ killed: true, stdout: "partial" });
  });

  it.skipIf(process.platform === "win32")("lets a command clean up on SIGTERM, and still reports the timeout", async () => {
    await expect(execCli(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => process.stdout.write('cleaned', () => process.exit(0))); setInterval(() => {}, 1000)"],
      { env: process.env, timeoutMs: 1_500 },
    )).rejects.toMatchObject({ killed: true, stdout: "cleaned" });
  });

  it.skipIf(process.platform === "win32")("settles when something the command started holds its output open", async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
      "process.stdout.write(String(worker.pid));",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const failure = await execCli(process.execPath, ["-e", script], { env: process.env, timeoutMs: 1_000 })
      .then(() => undefined, (error: { killed?: boolean; stdout?: string }) => error);
    const workerPid = Number(failure?.stdout);
    try {
      process.kill(workerPid, "SIGKILL");
    } catch {
      // Already gone.
    }
    expect(failure).toMatchObject({ killed: true });
    expect(workerPid).toBeGreaterThan(0);
  }, 15_000);

  it.skipIf(process.platform === "win32")("kills a command that ignores SIGTERM at the timeout", async () => {
    await expect(execCli(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 5000)"],
      { env: process.env, timeoutMs: 300 },
    )).rejects.toMatchObject({ killed: true });
  });
});

describe("childEnv for agy", () => {
  it("strips agy's conversation variable and keeps the rest", async () => {
    const { childEnv } = await import("../src/process.js");
    expect(childEnv("agy", { PATH: "/usr/bin", ANTIGRAVITY_CONVERSATION_ID: "parent", CODEX_THREAD_ID: "t" })).toEqual({
      PATH: "/usr/bin",
      CODEX_THREAD_ID: "t",
    });
  });
});
