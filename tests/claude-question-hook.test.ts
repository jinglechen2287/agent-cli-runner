import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { processClaudeQuestionHook } from "../src/claude-question-hook.js";

const tempDirs: string[] = [];

function stateFile(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "claude-question-hook-test-"));
  tempDirs.push(directory);
  const path = join(directory, "state.json");
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

function rawStateFile(value: string): string {
  const directory = mkdtempSync(join(tmpdir(), "claude-question-hook-test-"));
  tempDirs.push(directory);
  const path = join(directory, "state.json");
  writeFileSync(path, value, { mode: 0o600 });
  return path;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Claude question hook", () => {
  it("exits with Claude's blocking hook status for missing state path or malformed input", () => {
    const hookPath = join(process.cwd(), "dist", "claude-question-hook.js");
    const missingPath = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }),
      encoding: "utf8",
    });
    expect(missingPath.status).toBe(2);
    expect(missingPath.stdout).toBe("");
    expect(missingPath.stderr).toBe("");

    const malformed = spawnSync(process.execPath, [hookPath, stateFile({ mode: "defer" })], {
      input: "not json",
      encoding: "utf8",
    });
    expect(malformed.status).toBe(2);
    expect(malformed.stdout).toBe("");
    expect(malformed.stderr).toBe("");
  });

  it("exits with Claude's blocking hook status for malformed state", () => {
    const hookPath = join(process.cwd(), "dist", "claude-question-hook.js");
    const result = spawnSync(process.execPath, [hookPath, rawStateFile("not json")], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_use_id: "tool-1",
      }),
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("defers an AskUserQuestion call when no answer is ready", () => {
    const path = stateFile({ mode: "defer" });
    expect(processClaudeQuestionHook({
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_use_id: "tool-1",
      tool_input: { questions: [] },
    }, path)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "defer",
      },
    });
  });

  it("allows the matching deferred call with updated input and consumes the answer", () => {
    const path = stateFile({
      mode: "answer",
      toolUseId: "tool-1",
      updatedInput: {
        questions: [{ question: "Which?" }],
        answers: { "Which?": "React" },
      },
    });
    expect(processClaudeQuestionHook({
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_use_id: "tool-1",
      tool_input: { questions: [{ question: "Which?" }] },
    }, path)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: {
          questions: [{ question: "Which?" }],
          answers: { "Which?": "React" },
        },
      },
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mode: "defer" });
  });

  it("defers a different question without exposing the stored answer", () => {
    const path = stateFile({
      mode: "answer",
      toolUseId: "tool-1",
      updatedInput: { answers: { Secret: "value" } },
    });
    const stored = readFileSync(path, "utf8");
    expect(processClaudeQuestionHook({
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_use_id: "tool-2",
      tool_input: { questions: [] },
    }, path)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "defer",
      },
    });
    expect(readFileSync(path, "utf8")).toBe(stored);
  });
});
