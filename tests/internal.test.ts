import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { killTreeOnKill, launchCommand, resolveExecutable } from "../src/internal.js";

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
