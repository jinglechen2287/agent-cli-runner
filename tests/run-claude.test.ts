import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runClaude } from "../src/index.js";

const tempDirs: string[] = [];

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function readAll(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    stream.on("data", (chunk: Buffer | string) => {
      data += chunk.toString();
    });
    stream.on("end", () => resolve(data));
  });
}

function finish(child: FakeChild, code: number | null = 0): void {
  child.stdout.end();
  child.stderr.end();
  child.emit("close", code);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runClaude", () => {
  it("invokes claude with -p and stream-json output in the given cwd, passing the prompt via stdin", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const stdinData = readAll(child.stdin);

    const promise = runClaude({
      prompt: "make it round",
      cwd: "/tmp/proj",
      spawnFn: spawnFn as never,
    });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnFn.mock.calls[0]!;
    expect(cmd).toBe("claude");
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).not.toContain("make it round");
    expect(args).not.toContain("--append-system-prompt");
    expect(opts).toMatchObject({ cwd: "/tmp/proj" });

    finish(child);
    await expect(promise).resolves.toMatchObject({ exitCode: 0 });
    await expect(stdinData).resolves.toBe("make it round");
  });

  it("spawns a custom executable path when given", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      executablePath: "/opt/bin/claude-dev",
      spawnFn: spawnFn as never,
    });
    expect(spawnFn.mock.calls[0]![0]).toBe("/opt/bin/claude-dev");
    finish(child);
    await promise;
  });

  it("strips Claude nesting-guard variables from the spawn environment", async () => {
    vi.stubEnv("CLAUDECODE", "1");
    vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "cli");
    vi.stubEnv("CLAUDE_CODE_SESSION_ACCESS_TOKEN", "secret");
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({ prompt: "x", cwd: "/tmp", spawnFn: spawnFn as never });
    const env = spawnFn.mock.calls[0]![2].env as Record<string, string>;
    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(env).not.toHaveProperty("CLAUDE_CODE_SESSION_ACCESS_TOKEN");
    expect(env.PATH).toBe(process.env.PATH);
    finish(child);
    await promise;
  });

  it("applies stripping on top of a caller-provided base environment", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      env: { FOO: "bar", CLAUDECODE: "1" },
      spawnFn: spawnFn as never,
    });
    const env = spawnFn.mock.calls[0]![2].env as Record<string, string>;
    expect(env).toEqual({ FOO: "bar" });
    finish(child);
    await promise;
  });

  it("passes --append-system-prompt with the given text", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "make it round",
      cwd: "/tmp",
      appendSystemPrompt: "You are editing a running web app.",
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    const flagIndex = args.indexOf("--append-system-prompt");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe("You are editing a running web app.");
    finish(child);
    await promise;
  });

  it("passes --append-system-prompt alongside --resume on follow-up turns", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "follow up",
      cwd: "/tmp",
      resumeSessionId: "abc",
      appendSystemPrompt: "rules",
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    expect(args).toContain("--resume");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("rules");
    finish(child);
    await promise;
  });

  it("passes --permission-mode with the given mode", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "plan the change",
      cwd: "/tmp",
      permissionMode: "plan",
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    const flagIndex = args.indexOf("--permission-mode");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe("plan");
    finish(child);
    await promise;
  });

  it("omits --permission-mode by default", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({ prompt: "x", cwd: "/tmp", spawnFn: spawnFn as never });
    expect(spawnFn.mock.calls[0]![1]).not.toContain("--permission-mode");
    finish(child);
    await promise;
  });

  it("passes --disallowed-tools with the given tool names", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "plan the change",
      cwd: "/tmp",
      permissionMode: "plan",
      disallowedTools: ["ExitPlanMode", "Task"],
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    const flagIndex = args.indexOf("--disallowed-tools");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe("ExitPlanMode Task");
    finish(child);
    await promise;
  });

  it("omits --disallowed-tools when the list is empty", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      disallowedTools: [],
      spawnFn: spawnFn as never,
    });
    expect(spawnFn.mock.calls[0]![1]).not.toContain("--disallowed-tools");
    finish(child);
    await promise;
  });

  it("passes --tools as one comma-joined argument", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "answer a question",
      cwd: "/tmp",
      tools: ["Bash", "Read", "Glob"],
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    const flagIndex = args.indexOf("--tools");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe("Bash,Read,Glob");
    finish(child);
    await promise;
  });

  it('passes an explicit empty tools list as --tools "" to disable all built-ins', async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      tools: [],
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    const flagIndex = args.indexOf("--tools");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe("");
    finish(child);
    await promise;
  });

  it("omits --tools when the option is absent", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({ prompt: "x", cwd: "/tmp", spawnFn: spawnFn as never });
    expect(spawnFn.mock.calls[0]![1]).not.toContain("--tools");
    finish(child);
    await promise;
  });

  it("rejects isolated runs that set tools", async () => {
    await expect(
      runClaude({
        prompt: "x",
        cwd: "/tmp",
        isolated: true,
        tools: ["Read"],
        spawnFn: (() => makeFakeChild()) as never,
      }),
    ).rejects.toThrow(/isolated.*tools/i);
  });

  it("passes --setting-sources as one comma-joined argument", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      settingSources: ["project", "local"],
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    const flagIndex = args.indexOf("--setting-sources");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe("project,local");
    finish(child);
    await promise;
  });

  it("passes --settings through verbatim", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const settings = '{"permissions":{"allow":["WebFetch"]}}';
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      settings,
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    const flagIndex = args.indexOf("--settings");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe(settings);
    finish(child);
    await promise;
  });

  it("omits --setting-sources and --settings by default", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({ prompt: "x", cwd: "/tmp", spawnFn: spawnFn as never });
    const args = spawnFn.mock.calls[0]![1];
    expect(args).not.toContain("--setting-sources");
    expect(args).not.toContain("--settings");
    finish(child);
    await promise;
  });

  it("defers AskUserQuestion, collects answers, and resumes the same session", async () => {
    const version = makeFakeChild();
    const first = makeFakeChild();
    const resumed = makeFakeChild();
    const spawnFn = vi.fn()
      .mockReturnValueOnce(version)
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(resumed);
    const onToolUse = vi.fn();
    const onStderr = vi.fn();
    const onUserInputRequest = vi.fn(async () => ({
      answers: {
        "tool-question:0": ["React"],
        "tool-question:1": ["TypeScript", "Tests"],
      },
    }));
    const promise = runClaude({
      prompt: "build it",
      cwd: "/tmp",
      settings: JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: {
          PreToolUse: [{
            matcher: "Bash",
            hooks: [{ type: "command", command: "existing-hook" }],
          }],
        },
      }),
      spawnFn: spawnFn as never,
      onToolUse,
      onStderr,
      onUserInputRequest,
    });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0]![1]).toEqual(["--version"]);
    version.stdout.write("2.1.89 (Claude Code)\n");
    finish(version);
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(2));
    const initialArgs = spawnFn.mock.calls[1]![1] as string[];
    const settingsIndex = initialArgs.indexOf("--settings");
    const settingsPath = initialArgs[settingsIndex + 1] as string;
    const mergedSettings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      permissions: { allow: string[] };
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(mergedSettings.permissions.allow).toEqual(["Read"]);
    expect(mergedSettings.hooks.PreToolUse[0]).toMatchObject({ matcher: "Bash" });
    expect(mergedSettings.hooks.PreToolUse).toEqual(
      expect.arrayContaining([expect.objectContaining({ matcher: "AskUserQuestion" })]),
    );

    first.stdout.write(JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "tool-question",
          name: "AskUserQuestion",
          input: {},
        }],
      },
    }) + "\n");
    first.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      stop_reason: "tool_deferred",
      session_id: "session-question",
      deferred_tool_use: {
        id: "tool-question",
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: " Which framework? ",
              header: "Framework",
              options: [
                { label: "React", description: "Component-based UI" },
                { label: "Vue", description: "   " },
              ],
              multiSelect: false,
            },
            {
              question: "What should be included?",
              header: "Scope",
              options: [
                { label: "TypeScript", description: "Use strict types" },
                { label: "Tests" },
              ],
              multiSelect: true,
            },
          ],
        },
      },
    }) + "\n");
    finish(first);

    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(3));
    expect(onUserInputRequest).toHaveBeenCalledWith({
      requestId: "tool-question",
      questions: [
        {
          id: "tool-question:0",
          header: "Framework",
          question: "Which framework?",
          options: [
            { label: "React", description: "Component-based UI" },
            { label: "Vue" },
          ],
          multiSelect: false,
          allowOther: true,
          secret: false,
        },
        {
          id: "tool-question:1",
          header: "Scope",
          question: "What should be included?",
          options: [
            { label: "TypeScript", description: "Use strict types" },
            { label: "Tests" },
          ],
          multiSelect: true,
          allowOther: true,
          secret: false,
        },
      ],
    });
    expect(onToolUse).not.toHaveBeenCalled();

    const questionHook = mergedSettings.hooks.PreToolUse.find(
      ({ matcher }) => matcher === "AskUserQuestion",
    );
    const statePath = /'([^']*)'$/.exec(questionHook?.hooks[0]?.command ?? "")?.[1];
    expect(statePath).toBeDefined();
    if (process.platform !== "win32") {
      expect(statSync(dirname(statePath!)).mode & 0o777).toBe(0o700);
      expect(statSync(statePath!).mode & 0o777).toBe(0o600);
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(statePath!, "utf8"))).toEqual({
      mode: "answer",
      toolUseId: "tool-question",
      updatedInput: {
        questions: [
          {
            question: " Which framework? ",
            header: "Framework",
            options: [
              { label: "React", description: "Component-based UI" },
              { label: "Vue", description: "   " },
            ],
            multiSelect: false,
          },
          {
            question: "What should be included?",
            header: "Scope",
            options: [
              { label: "TypeScript", description: "Use strict types" },
              { label: "Tests" },
            ],
            multiSelect: true,
          },
        ],
        answers: {
          " Which framework? ": "React",
          "What should be included?": "TypeScript, Tests",
        },
      },
    });

    const resumedArgs = spawnFn.mock.calls[2]![1] as string[];
    expect(resumedArgs).toContain("--resume");
    expect(resumedArgs[resumedArgs.indexOf("--resume") + 1]).toBe("session-question");
    expect(JSON.stringify(resumedArgs)).not.toContain("React");
    expect(JSON.stringify(resumedArgs)).not.toContain("TypeScript");
    expect(JSON.stringify(spawnFn.mock.calls[2]![2].env)).not.toContain("React");
    expect(JSON.stringify(spawnFn.mock.calls[2]![2].env)).not.toContain("TypeScript");
    resumed.stdout.write(JSON.stringify({
      type: "result",
      result: "Implemented",
      session_id: "session-question",
    }) + "\n");
    finish(resumed);

    await expect(promise).resolves.toMatchObject({
      text: "Implemented",
      exitCode: 0,
      sessionId: "session-question",
    });
    expect(() => readFileSync(settingsPath, "utf8")).toThrow();
    expect(() => readFileSync(statePath!, "utf8")).toThrow();
    expect(onStderr).not.toHaveBeenCalled();
  });

  it("bounds repeated question deferrals even when no wall-clock timeout is configured", async () => {
    const version = makeFakeChild();
    const turns = Array.from({ length: 65 }, () => makeFakeChild());
    const spawnFn = vi.fn().mockReturnValueOnce(version);
    for (const turn of turns) spawnFn.mockReturnValueOnce(turn);
    const onUserInputRequest = vi.fn(async (request: { questions: Array<{ id: string }> }) => ({
      answers: { [request.questions[0]!.id]: ["A"] },
    }));
    const promise = runClaude({
      prompt: "keep asking",
      cwd: "/tmp",
      spawnFn: spawnFn as never,
      onUserInputRequest,
    });
    version.stdout.write("2.1.89 (Claude Code)\n");
    finish(version);

    for (const [index, turn] of turns.entries()) {
      await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(index + 2));
      turn.stdout.write(JSON.stringify({
        type: "result",
        stop_reason: "tool_deferred",
        session_id: "session-loop",
        deferred_tool_use: {
          id: `tool-question-${index}`,
          name: "AskUserQuestion",
          input: {
            questions: [{
              question: `Question ${index}?`,
              header: "Question",
              options: [{ label: "A" }],
              multiSelect: false,
            }],
          },
        },
      }) + "\n");
      finish(turn);
    }

    await expect(promise).rejects.toThrow("exceeded 64 deferred questions");
    expect(onUserInputRequest).toHaveBeenCalledTimes(64);
    for (const call of spawnFn.mock.calls.slice(2)) {
      const args = call[1] as string[];
      expect(args[args.indexOf("--resume") + 1]).toBe("session-loop");
    }
  });

  it("loads file-based settings, preserves their hooks, and removes only merged files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-cli-runner-settings-test-"));
    tempDirs.push(directory);
    const callerSettingsPath = join(directory, "caller-settings.json");
    writeFileSync(callerSettingsPath, JSON.stringify({
      permissions: { deny: ["Write"] },
      hooks: {
        PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "after-read" }] }],
      },
    }));
    const version = makeFakeChild();
    const turn = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(version).mockReturnValueOnce(turn);
    const promise = runClaude({
      prompt: "inspect",
      cwd: directory,
      settings: "caller-settings.json",
      spawnFn: spawnFn as never,
      onUserInputRequest: async () => ({ answers: {} }),
    });
    version.stdout.write("2.1.89 (Claude Code)\n");
    finish(version);
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(2));

    const args = spawnFn.mock.calls[1]![1] as string[];
    const mergedSettingsPath = args[args.indexOf("--settings") + 1] as string;
    expect(mergedSettingsPath).not.toBe(callerSettingsPath);
    const merged = JSON.parse(readFileSync(mergedSettingsPath, "utf8")) as {
      permissions: { deny: string[] };
      hooks: {
        PostToolUse: Array<{ matcher: string }>;
        PreToolUse: Array<{ matcher: string }>;
      };
    };
    expect(merged.permissions.deny).toEqual(["Write"]);
    expect(merged.hooks.PostToolUse).toEqual([expect.objectContaining({ matcher: "Read" })]);
    expect(merged.hooks.PreToolUse).toEqual([
      expect.objectContaining({ matcher: "AskUserQuestion" }),
    ]);
    turn.stdout.write(JSON.stringify({ type: "result", result: "Done" }) + "\n");
    finish(turn);
    await expect(promise).resolves.toMatchObject({ text: "Done", exitCode: 0 });
    expect(readFileSync(callerSettingsPath, "utf8")).toContain('"Write"');
    expect(() => readFileSync(mergedSettingsPath, "utf8")).toThrow();
  });

  it("rejects malformed inline settings and unreadable settings files clearly", async () => {
    for (const settings of ["{not-json", "missing-settings.json"]) {
      const version = makeFakeChild();
      const spawnFn = vi.fn().mockReturnValueOnce(version);
      const promise = runClaude({
        prompt: "inspect",
        cwd: "/tmp",
        settings,
        spawnFn: spawnFn as never,
        onUserInputRequest: async () => ({ answers: {} }),
      });
      version.stdout.write("2.1.89 (Claude Code)\n");
      finish(version);
      await expect(promise).rejects.toThrow("Unable to read Claude settings:");
      expect(spawnFn).toHaveBeenCalledTimes(1);
    }
  });

  it("cancels while awaiting an answer and removes the hook state", async () => {
    const version = makeFakeChild();
    const first = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(version).mockReturnValueOnce(first);
    const abort = new AbortController();
    const onUserInputRequest = vi.fn(() => new Promise<never>(() => {}));
    const promise = runClaude({
      prompt: "ask",
      cwd: "/tmp",
      spawnFn: spawnFn as never,
      signal: abort.signal,
      onUserInputRequest,
    });
    version.stdout.write("2.1.89 (Claude Code)\n");
    finish(version);
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(2));
    const args = spawnFn.mock.calls[1]![1] as string[];
    const settingsPath = args[args.indexOf("--settings") + 1] as string;
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    const hook = settings.hooks.PreToolUse.find(({ matcher }) => matcher === "AskUserQuestion");
    const statePath = /'([^']*)'$/.exec(hook?.hooks[0]?.command ?? "")?.[1];
    first.stdout.write(JSON.stringify({
      type: "result",
      stop_reason: "tool_deferred",
      session_id: "session-cancel",
      deferred_tool_use: {
        id: "tool-cancel",
        name: "AskUserQuestion",
        input: {
          questions: [{
            question: "Continue?",
            header: "Continue",
            options: [{ label: "Yes" }],
            multiSelect: false,
          }],
        },
      },
    }) + "\n");
    finish(first);
    await vi.waitFor(() => expect(onUserInputRequest).toHaveBeenCalledTimes(1));
    abort.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(() => readFileSync(settingsPath, "utf8")).toThrow();
    expect(() => readFileSync(statePath!, "utf8")).toThrow();
  });

  it("preserves special Claude question-text keys in updatedInput", async () => {
    const version = makeFakeChild();
    const first = makeFakeChild();
    const resumed = makeFakeChild();
    const spawnFn = vi.fn()
      .mockReturnValueOnce(version)
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(resumed);
    const promise = runClaude({
      prompt: "ask",
      cwd: "/tmp",
      spawnFn: spawnFn as never,
      onUserInputRequest: async (request) => ({
        answers: { [request.questions[0]!.id]: ["Safe"] },
      }),
    });
    version.stdout.write("2.1.89 (Claude Code)\n");
    finish(version);
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(2));
    first.stdout.write(JSON.stringify({
      type: "result",
      stop_reason: "tool_deferred",
      session_id: "session-special",
      deferred_tool_use: {
        id: "tool-special",
        name: "AskUserQuestion",
        input: {
          questions: [{
            question: "__proto__",
            header: "Special",
            options: [{ label: "Safe" }],
            multiSelect: false,
          }],
        },
      },
    }) + "\n");
    finish(first);
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(3));

    const resumedArgs = spawnFn.mock.calls[2]![1] as string[];
    const settingsPath = resumedArgs[resumedArgs.indexOf("--settings") + 1] as string;
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    const hook = settings.hooks.PreToolUse.find(({ matcher }) => matcher === "AskUserQuestion");
    const statePath = /'([^']*)'$/.exec(hook?.hooks[0]?.command ?? "")?.[1];
    const state = JSON.parse(readFileSync(statePath!, "utf8")) as {
      updatedInput: { answers: Record<string, string> };
    };
    expect(Object.hasOwn(state.updatedInput.answers, "__proto__")).toBe(true);
    expect(state.updatedInput.answers["__proto__"]).toBe("Safe");

    resumed.stdout.write(JSON.stringify({
      type: "result",
      result: "Done",
      session_id: "session-special",
    }) + "\n");
    finish(resumed);
    await expect(promise).resolves.toMatchObject({ text: "Done", exitCode: 0 });
  });

  it("rejects native questions with an actionable error on older Claude Code", async () => {
    const version = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(version);
    const promise = runClaude({
      prompt: "build it",
      cwd: "/tmp",
      spawnFn: spawnFn as never,
      onUserInputRequest: async () => ({ answers: {} }),
    });
    version.stdout.write("2.1.88 (Claude Code)\n");
    finish(version);
    await expect(promise).rejects.toThrow(
      "Native AskUserQuestion requires Claude Code 2.1.89 or newer; found 2.1.88",
    );
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate and malformed deferred Claude questions before the callback", async () => {
    async function runWithQuestions(questions: unknown[]): Promise<unknown> {
      const version = makeFakeChild();
      const first = makeFakeChild();
      const spawnFn = vi.fn()
        .mockReturnValueOnce(version)
        .mockReturnValueOnce(first);
      const promise = runClaude({
        prompt: "build it",
        cwd: "/tmp",
        spawnFn: spawnFn as never,
        onUserInputRequest: async () => ({ answers: {} }),
      });
      version.stdout.write("2.1.89 (Claude Code)\n");
      finish(version);
      await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(2));
      first.stdout.write(JSON.stringify({
        type: "result",
        subtype: "success",
        stop_reason: "tool_deferred",
        session_id: "session-invalid-question",
        deferred_tool_use: {
          id: "tool-invalid-question",
          name: "AskUserQuestion",
          input: { questions },
        },
      }) + "\n");
      finish(first);
      return promise;
    }

    await expect(runWithQuestions([
      { question: "Same?", header: "First", options: [], multiSelect: false },
      { question: " Same? ", header: "Second", options: [], multiSelect: false },
    ])).rejects.toThrow("Claude AskUserQuestion contains duplicate question text");
    await expect(runWithQuestions([{
      question: "Choose?",
      header: "Choice",
      options: [{ label: "A", description: 7 }],
      multiSelect: "yes",
    }])).rejects.toThrow("Malformed Claude AskUserQuestion option description");
    await expect(runWithQuestions([{
      question: "Choose?",
      header: "Choice",
      options: [{ label: "A" }],
      multiSelect: "yes",
    }])).rejects.toThrow("Malformed Claude AskUserQuestion multiSelect");
  });

  it("passes --permission-mode alongside --resume on follow-up turns", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "follow up",
      cwd: "/tmp",
      resumeSessionId: "abc",
      permissionMode: "plan",
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    expect(args).toContain("--resume");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
    finish(child);
    await promise;
  });

  it("rejects isolated runs that set a permission mode", async () => {
    await expect(
      runClaude({
        prompt: "x",
        cwd: "/tmp",
        isolated: true,
        permissionMode: "plan",
        spawnFn: (() => makeFakeChild()) as never,
      }),
    ).rejects.toThrow(/isolated.*permission/i);
  });

  it("passes --session-id when newSessionId is provided", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      newSessionId: "11111111-1111-1111-1111-111111111111",
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    expect(args).toContain("--session-id");
    expect(args).toContain("11111111-1111-1111-1111-111111111111");
    finish(child);
    await promise;
  });

  it("runs isolated one-shot requests without tools, customizations, MCP, or persistence", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "title this",
      cwd: "/tmp",
      isolated: true,
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    expect(args).toEqual(expect.arrayContaining([
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
    ]));
    finish(child);
    await promise;
  });

  it("passes --resume when resumeSessionId is provided", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const promise = runClaude({
      prompt: "follow up",
      cwd: "/tmp",
      resumeSessionId: "abc",
      spawnFn: spawnFn as never,
    });
    const [, args] = spawnFn.mock.calls[0]!;
    expect(args).toContain("--resume");
    expect(args).toContain("abc");
    expect(args).not.toContain("--session-id");
    finish(child);
    await promise;
  });

  it("rejects instead of throwing when spawnFn throws synchronously", async () => {
    await expect(
      runClaude({
        prompt: "x",
        cwd: "/tmp",
        spawnFn: (() => {
          throw new Error("sync spawn failure");
        }) as never,
      }),
    ).rejects.toThrow(/sync spawn failure/);
  });

  it("reassembles multibyte characters split across stdout chunks", async () => {
    const child = makeFakeChild();
    const onAssistantText = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onAssistantText,
    });
    const line = Buffer.from(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "café ☕☕" }] },
      }) + "\n",
    );
    // Split inside the final ☕ (a 3-byte UTF-8 sequence).
    const splitAt = line.length - 4;
    child.stdout.write(line.subarray(0, splitAt));
    child.stdout.write(line.subarray(splitAt));
    finish(child);
    await promise;
    expect(onAssistantText).toHaveBeenCalledWith("café ☕☕");
  });

  it("rejects when both newSessionId and resumeSessionId are given", async () => {
    await expect(
      runClaude({
        prompt: "x",
        cwd: "/tmp",
        newSessionId: "a",
        resumeSessionId: "b",
        spawnFn: (() => makeFakeChild()) as never,
      }),
    ).rejects.toThrow(/mutually exclusive|both/i);
  });

  it("emits the session id from the system.init event and returns it in the result", async () => {
    const child = makeFakeChild();
    const onSessionId = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onSessionId,
    });
    child.stdout.write(
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }) + "\n",
    );
    finish(child);
    const result = await promise;
    expect(onSessionId).toHaveBeenCalledWith("sess-1");
    expect(onSessionId).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBe("sess-1");
  });

  it("emits assistant text via onAssistantText", async () => {
    const child = makeFakeChild();
    const onAssistantText = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onAssistantText,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello there" }] },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onAssistantText).toHaveBeenCalledWith("Hello there");
  });

  it("requests partial messages only when a delta callback is supplied", async () => {
    const withoutDelta = makeFakeChild();
    const plainSpawn = vi.fn().mockReturnValue(withoutDelta);
    const plain = runClaude({ prompt: "x", cwd: "/tmp", spawnFn: plainSpawn as never });
    expect(plainSpawn.mock.calls[0]![1]).not.toContain("--include-partial-messages");
    finish(withoutDelta);
    await plain;

    const withDelta = makeFakeChild();
    const streamingSpawn = vi.fn().mockReturnValue(withDelta);
    const streaming = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: streamingSpawn as never,
      onAssistantTextDelta: vi.fn(),
    });
    expect(streamingSpawn.mock.calls[0]![1]).toContain("--include-partial-messages");
    finish(withDelta);
    await streaming;
  });

  it("emits text deltas in order and still reports the completed message", async () => {
    const child = makeFakeChild();
    const onAssistantTextDelta = vi.fn();
    const onAssistantText = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onAssistantTextDelta,
      onAssistantText,
    });
    for (const text of ["Hello", " there"]) {
      child.stdout.write(
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
        }) + "\n",
      );
    }
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello there" }] },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onAssistantTextDelta.mock.calls.map(([chunk]) => chunk)).toEqual(["Hello", " there"]);
    expect(onAssistantText).toHaveBeenCalledWith("Hello there");
  });

  // Extended thinking and streamed tool input share the content_block_delta
  // envelope; only text_delta belongs in the transcript.
  it("ignores thinking, signature, and tool-input deltas", async () => {
    const child = makeFakeChild();
    const onAssistantTextDelta = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onAssistantTextDelta,
    });
    const deltas = [
      { type: "thinking_delta", thinking: "pondering" },
      { type: "signature_delta", signature: "sig" },
      { type: "input_json_delta", partial_json: '{"a":' },
    ];
    for (const delta of deltas) {
      child.stdout.write(
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", index: 0, delta },
        }) + "\n",
      );
    }
    finish(child);
    await promise;
    expect(onAssistantTextDelta).not.toHaveBeenCalled();
  });

  // Background subagents stream through the parent's stdout tagged with the
  // spawning tool call; their prose is not the parent turn's transcript.
  it("ignores text deltas emitted by a background subagent", async () => {
    const child = makeFakeChild();
    const onAssistantTextDelta = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onAssistantTextDelta,
    });
    child.stdout.write(
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "subagent prose" },
        },
        parent_tool_use_id: "toolu_123",
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "main prose" },
        },
        parent_tool_use_id: null,
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onAssistantTextDelta.mock.calls.map(([chunk]) => chunk)).toEqual(["main prose"]);
  });

  it("emits full lifecycle snapshots for background subagents", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const child = makeFakeChild();
    const onBackgroundAgentUpdate = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onBackgroundAgentUpdate,
    });

    child.stdout.write(JSON.stringify({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "tool-1",
      description: "Inspect authentication",
      task_type: "local_agent",
    }) + "\n");
    vi.setSystemTime(2_000);
    child.stdout.write(JSON.stringify({
      type: "system",
      subtype: "task_progress",
      task_id: "task-1",
      tool_use_id: "tool-1",
      description: "Inspect authentication",
      subagent_type: "Explore",
      usage: { total_tokens: 1200, tool_uses: 4, duration_ms: 900 },
      last_tool_name: "Grep",
      summary: "Found the session middleware",
    }) + "\n");
    vi.setSystemTime(2_500);
    child.stdout.write(JSON.stringify({
      type: "system",
      subtype: "task_progress",
      task_id: "task-1",
      usage: { duration_ms: 1_400 },
    }) + "\n");
    vi.setSystemTime(3_000);
    child.stdout.write(JSON.stringify({
      type: "system",
      subtype: "task_updated",
      task_id: "task-1",
      patch: { status: "completed", end_time: 2_900 },
    }) + "\n");
    vi.setSystemTime(4_000);
    child.stdout.write(JSON.stringify({
      type: "system",
      subtype: "task_updated",
      task_id: "task-1",
      patch: { status: "completed", end_time: 3_900 },
    }) + "\n");
    finish(child);
    await promise;

    expect(onBackgroundAgentUpdate.mock.calls).toEqual([
      [{
        id: "task-1",
        provider: "claude",
        parentToolCallId: "tool-1",
        description: "Inspect authentication",
        agentType: "local_agent",
        status: "running",
        startedAt: 1_000,
        updatedAt: 1_000,
      }],
      [{
        id: "task-1",
        provider: "claude",
        parentToolCallId: "tool-1",
        description: "Inspect authentication",
        agentType: "Explore",
        status: "running",
        summary: "Found the session middleware",
        progress: {
          totalTokens: 1200,
          toolUses: 4,
          durationMs: 900,
          lastToolName: "Grep",
        },
        startedAt: 1_000,
        updatedAt: 2_000,
      }],
      [{
        id: "task-1",
        provider: "claude",
        parentToolCallId: "tool-1",
        description: "Inspect authentication",
        agentType: "Explore",
        status: "running",
        summary: "Found the session middleware",
        progress: {
          totalTokens: 1200,
          toolUses: 4,
          durationMs: 1_400,
          lastToolName: "Grep",
        },
        startedAt: 1_000,
        updatedAt: 2_500,
      }],
      [{
        id: "task-1",
        provider: "claude",
        parentToolCallId: "tool-1",
        description: "Inspect authentication",
        agentType: "Explore",
        status: "completed",
        summary: "Found the session middleware",
        progress: {
          totalTokens: 1200,
          toolUses: 4,
          durationMs: 1_400,
          lastToolName: "Grep",
        },
        startedAt: 1_000,
        updatedAt: 3_000,
        endedAt: 2_900,
      }],
      [{
        id: "task-1",
        provider: "claude",
        parentToolCallId: "tool-1",
        description: "Inspect authentication",
        agentType: "Explore",
        status: "completed",
        summary: "Found the session middleware",
        progress: {
          totalTokens: 1200,
          toolUses: 4,
          durationMs: 1_400,
          lastToolName: "Grep",
        },
        startedAt: 1_000,
        updatedAt: 4_000,
        endedAt: 2_900,
      }],
    ]);
  });

  it("contains background-agent callback errors", async () => {
    const child = makeFakeChild();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onBackgroundAgentUpdate: () => {
        throw new Error("host callback failed");
      },
    });
    expect(() => child.stdout.write(JSON.stringify({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      description: "Inspect authentication",
      task_type: "local_agent",
    }) + "\n")).not.toThrow();
    finish(child);
    await expect(promise).resolves.toMatchObject({ exitCode: 0 });
  });

  it("does not report background shell tasks as background agents", async () => {
    const child = makeFakeChild();
    const onBackgroundAgentUpdate = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onBackgroundAgentUpdate,
    });
    child.stdout.write(JSON.stringify({
      type: "system",
      subtype: "task_started",
      task_id: "bash-1",
      description: "Run tests",
      task_type: "local_bash",
    }) + "\n");
    finish(child);
    await promise;
    expect(onBackgroundAgentUpdate).not.toHaveBeenCalled();
  });

  it("recognizes an older untyped task by its Agent tool correlation", async () => {
    const child = makeFakeChild();
    const onBackgroundAgentUpdate = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onBackgroundAgentUpdate,
    });
    child.stdout.write(JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "tool-legacy",
          name: "Agent",
          input: { description: "Inspect authentication" },
        }],
      },
    }) + "\n");
    child.stdout.write(JSON.stringify({
      type: "system",
      subtype: "task_started",
      task_id: "task-legacy",
      tool_use_id: "tool-legacy",
      description: "Inspect authentication",
    }) + "\n");
    child.stdout.write(JSON.stringify({
      type: "system",
      subtype: "task_updated",
      task_id: "task-legacy",
      patch: { status: "killed", error: "Stopped by parent" },
    }) + "\n");
    finish(child);
    await promise;

    expect(onBackgroundAgentUpdate).toHaveBeenCalledTimes(2);
    expect(onBackgroundAgentUpdate.mock.calls[1]?.[0]).toMatchObject({
      id: "task-legacy",
      parentToolCallId: "tool-legacy",
      status: "interrupted",
      error: "Stopped by parent",
      endedAt: expect.any(Number),
    });
  });

  it("concatenates multiple text blocks in one assistant message", async () => {
    const child = makeFakeChild();
    const onAssistantText = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onAssistantText,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Part one. " },
            { type: "text", text: "Part two." },
          ],
        },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onAssistantText).toHaveBeenCalledWith("Part one. Part two.");
  });

  it("returns the result event's text and session id", async () => {
    const child = makeFakeChild();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Working on it" }] },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({ type: "result", result: "Final answer", session_id: "sess-9" }) +
        "\n",
    );
    finish(child);
    await expect(promise).resolves.toEqual({
      text: "Final answer",
      exitCode: 0,
      sessionId: "sess-9",
    });
  });

  it("falls back to the last assistant text when no result event arrives", async () => {
    const child = makeFakeChild();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });
    for (const text of ["First message", "Second message"]) {
      child.stdout.write(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text }] },
        }) + "\n",
      );
    }
    finish(child);
    const result = await promise;
    expect(result.text).toBe("Second message");
  });

  it("emits tool_use events via onToolUse", async () => {
    const child = makeFakeChild();
    const onToolUse = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onToolUse,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Edit",
              input: { file_path: "src/Button.tsx" },
            },
          ],
        },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onToolUse).toHaveBeenCalledWith({
      callId: "t1",
      name: "Edit",
      summary: "src/Button.tsx",
      input: { file_path: "src/Button.tsx" },
    });
  });

  it("summarizes each known tool by its most identifying input field", async () => {
    const cases: Array<{
      name: string;
      input: Record<string, unknown>;
      summary: string | undefined;
    }> = [
      { name: "Read", input: { file_path: "a.ts" }, summary: "a.ts" },
      { name: "Bash", input: { command: "pnpm test" }, summary: "pnpm test" },
      { name: "Grep", input: { pattern: "TODO" }, summary: "TODO" },
      { name: "WebFetch", input: { url: "https://x.dev" }, summary: "https://x.dev" },
      { name: "WebSearch", input: { query: "vitest" }, summary: "vitest" },
      {
        name: "TaskCreate",
        input: { subject: "Ship task indicators" },
        summary: "Ship task indicators",
      },
      {
        name: "TaskUpdate",
        input: { taskId: "12", status: "in_progress" },
        summary: "Task #12 · in progress",
      },
      { name: "TodoWrite", input: { todos: [] }, summary: undefined },
      { name: "Skill", input: { skill: "code-review" }, summary: "code-review" },
      {
        name: "Skill",
        input: { skill: "linear", args: "list" },
        summary: "linear · list",
      },
      {
        name: "mcp__linear__create_issue",
        input: { title: "Bug" },
        summary: undefined,
      },
    ];

    for (const c of cases) {
      const child = makeFakeChild();
      const onToolUse = vi.fn();
      const promise = runClaude({
        prompt: "x",
        cwd: "/tmp",
        spawnFn: (() => child) as never,
        onToolUse,
      });
      child.stdout.write(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "t", name: c.name, input: c.input }],
          },
        }) + "\n",
      );
      finish(child);
      await promise;
      expect(onToolUse).toHaveBeenCalledWith({
        callId: "t",
        name: c.name,
        ...(c.summary !== undefined ? { summary: c.summary } : {}),
        input: c.input,
      });
    }
  });

  it("normalizes Claude TodoWrite todos into a plan snapshot", async () => {
    const child = makeFakeChild();
    const onToolUse = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onToolUse,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t",
              name: "TodoWrite",
              input: {
                todos: [
                  { content: "Map plumbing", status: "completed", activeForm: "Mapping" },
                  { content: "Wire endpoint", status: "in_progress", activeForm: "Wiring" },
                  { content: "Verify", status: "pending", activeForm: "Verifying" },
                ],
              },
            },
          ],
        },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onToolUse).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "TodoWrite",
        summary: "1/3 steps completed",
        planItems: [
          { text: "Map plumbing", status: "completed" },
          { text: "Wire endpoint", status: "in_progress" },
          { text: "Verify", status: "pending" },
        ],
      }),
    );
  });

  it("leaves an empty TodoWrite without a plan snapshot", async () => {
    const child = makeFakeChild();
    const onToolUse = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onToolUse,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t", name: "TodoWrite", input: { todos: [] } }],
        },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onToolUse).toHaveBeenCalledWith({ callId: "t", name: "TodoWrite", input: { todos: [] } });
  });

  it("collapses a multiline command into a one-line summary", async () => {
    const child = makeFakeChild();
    const onToolUse = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onToolUse,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t",
              name: "Bash",
              input: { command: "pnpm build\n  && pnpm test" },
            },
          ],
        },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onToolUse).toHaveBeenCalledWith({
      callId: "t",
      name: "Bash",
      summary: "pnpm build && pnpm test",
      input: { command: "pnpm build\n  && pnpm test" },
    });
  });

  it("omits the summary when the input field is empty or whitespace", async () => {
    const child = makeFakeChild();
    const onToolUse = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onToolUse,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t", name: "Bash", input: { command: "   " } },
          ],
        },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onToolUse).toHaveBeenCalledWith({
      callId: "t",
      name: "Bash",
      input: { command: "   " },
    });
  });

  it("emits Claude tool results with their matching call id", async () => {
    const child = makeFakeChild();
    const onToolResult = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onToolResult,
    });
    child.stdout.write(
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "task-create-1",
              content: "Task #7 created successfully: Ship task indicators",
              is_error: false,
            },
          ],
        },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onToolResult).toHaveBeenCalledWith({
      callId: "task-create-1",
      content: "Task #7 created successfully: Ship task indicators",
      isError: false,
    });
  });

  it("handles split JSONL lines across multiple stdout chunks", async () => {
    const child = makeFakeChild();
    const onAssistantText = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onAssistantText,
    });
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "split-line" }] },
    });
    child.stdout.write(line.slice(0, 10));
    child.stdout.write(line.slice(10) + "\n");
    finish(child);
    await promise;
    expect(onAssistantText).toHaveBeenCalledWith("split-line");
  });

  it("ignores malformed JSON lines without throwing", async () => {
    const child = makeFakeChild();
    const onAssistantText = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onAssistantText,
    });
    child.stdout.write("not json\n");
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onAssistantText).toHaveBeenCalledWith("ok");
  });

  it("streams stderr chunks to onStderr", async () => {
    const child = makeFakeChild();
    const onStderr = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onStderr,
    });
    child.stderr.write("oops");
    finish(child, 1);
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(onStderr).toHaveBeenCalledWith("oops");
  });

  it("rejects with MissingCliError when the executable is absent", async () => {
    const child = makeFakeChild();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });
    child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
    await expect(promise).rejects.toMatchObject({
      name: "MissingCliError",
      cli: "claude",
    });
  });

  it("rejects with the original error for non-ENOENT spawn failures", async () => {
    const child = makeFakeChild();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });
    child.emit("error", new Error("EACCES: permission denied"));
    await expect(promise).rejects.toThrow(/permission denied/);
  });

  it("kills the child with SIGTERM when signal is aborted", async () => {
    const child = makeFakeChild();
    const controller = new AbortController();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      signal: controller.signal,
    });
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    finish(child, null);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with AbortError if the signal is already aborted before spawn ends", async () => {
    const child = makeFakeChild();
    const controller = new AbortController();
    controller.abort();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      signal: controller.signal,
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    finish(child, null);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("escalates to SIGKILL if the child does not exit within the grace period", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const controller = new AbortController();
      const promise = runClaude({
        prompt: "x",
        cwd: "/tmp",
        spawnFn: (() => child) as never,
        signal: controller.signal,
      });
      controller.abort();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      vi.advanceTimersByTime(2500);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      finish(child, null);
      await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with TimeoutError when timeoutMs elapses", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const promise = runClaude({
        prompt: "x",
        cwd: "/tmp",
        timeoutMs: 500,
        spawnFn: (() => child) as never,
      });
      vi.advanceTimersByTime(600);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      vi.advanceTimersByTime(2100);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      finish(child, null);
      await expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats null exit code as -1", async () => {
    const child = makeFakeChild();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });
    finish(child, null);
    const result = await promise;
    expect(result.exitCode).toBe(-1);
  });

  it("emits normalized usage per assistant message, summing input and cache lanes", async () => {
    const child = makeFakeChild();
    const onUsage = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onUsage,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "hi" }],
          usage: {
            input_tokens: 2,
            cache_read_input_tokens: 15099,
            cache_creation_input_tokens: 6490,
            output_tokens: 6,
          },
        },
      }) + "\n",
    );
    finish(child);
    await promise;
    expect(onUsage).toHaveBeenCalledWith({
      contextTokens: 2 + 15099 + 6490,
      inputTokens: 2,
      cachedInputTokens: 15099,
      outputTokens: 6,
      model: "claude-opus-4-8",
      contextWindow: 200_000,
    });
  });

  it("corrects the window from the result event's authoritative modelUsage and returns it", async () => {
    const child = makeFakeChild();
    const onUsage = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onUsage,
    });
    // A turn that also billed a small sub-agent model (Haiku): the primary
    // model is the one that produced the final assistant message.
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 2, cache_read_input_tokens: 15099, output_tokens: 6 },
        },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        type: "result",
        result: "done",
        session_id: "s1",
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 15099,
          cache_creation_input_tokens: 6490,
          output_tokens: 6,
        },
        modelUsage: {
          "claude-haiku-4-5-20251001": { contextWindow: 200_000 },
          "claude-opus-4-8[1m]": { contextWindow: 1_000_000 },
        },
      }) + "\n",
    );
    finish(child);
    const result = await promise;
    const finalUsage = {
      contextTokens: 2 + 15099,
      inputTokens: 2,
      cachedInputTokens: 15099,
      outputTokens: 6,
      model: "claude-opus-4-8[1m]",
      contextWindow: 1_000_000,
    };
    expect(onUsage).toHaveBeenLastCalledWith(finalUsage);
    expect(result.usage).toEqual(finalUsage);
  });

  it("keeps the last per-message occupancy at result instead of the turn's cumulative totals", async () => {
    const child = makeFakeChild();
    const onUsage = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onUsage,
    });
    // A two-request turn. The result event's usage sums both requests
    // (10+8 input, 4780+280 cache writes, 17418+22198 cache reads), so it does
    // NOT describe context occupancy — the last message's usage does.
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }],
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 4780,
            cache_read_input_tokens: 17418,
            output_tokens: 90,
          },
        },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "done" }],
          usage: {
            input_tokens: 8,
            cache_creation_input_tokens: 280,
            cache_read_input_tokens: 22198,
            output_tokens: 195,
          },
        },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        type: "result",
        result: "done",
        usage: {
          input_tokens: 18,
          cache_creation_input_tokens: 5060,
          cache_read_input_tokens: 39616,
          output_tokens: 285,
        },
        modelUsage: { "claude-opus-4-8[1m]": { contextWindow: 1_000_000 } },
      }) + "\n",
    );
    finish(child);
    const result = await promise;
    expect(result.usage).toEqual({
      contextTokens: 8 + 280 + 22198,
      inputTokens: 8,
      cachedInputTokens: 22198,
      outputTokens: 195,
      model: "claude-opus-4-8[1m]",
      contextWindow: 1_000_000,
    });
  });

  it("ignores a malformed modelUsage contextWindow and falls back to the family rule", async () => {
    const child = makeFakeChild();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        type: "result",
        result: "hi",
        usage: { input_tokens: 5, output_tokens: 3 },
        modelUsage: { "claude-opus-4-8": { contextWindow: "huge" } },
      }) + "\n",
    );
    finish(child);
    const result = await promise;
    expect(result.usage).toMatchObject({
      model: "claude-opus-4-8",
      contextWindow: 200_000,
    });
  });

  it("attributes result usage to the responding model even when its message carried no usage", async () => {
    const child = makeFakeChild();
    const onUsage = vi.fn();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onUsage,
    });
    // A tool-only assistant message: it names the responding model but omits
    // usage. Its model must still win over the larger-window model at result.
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "a.ts" } }],
        },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        type: "result",
        result: "done",
        usage: { input_tokens: 5, output_tokens: 3 },
        modelUsage: {
          "claude-haiku-4-5-20251001": { contextWindow: 200_000 },
          "claude-opus-4-8[1m]": { contextWindow: 1_000_000 },
        },
      }) + "\n",
    );
    finish(child);
    const result = await promise;
    expect(result.usage).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      contextWindow: 200_000,
    });
  });

  it("omits usage from the result when the CLI reports no token counts", async () => {
    const child = makeFakeChild();
    const promise = runClaude({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });
    child.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
      }) + "\n",
    );
    finish(child);
    const result = await promise;
    expect(result.usage).toBeUndefined();
  });
});
