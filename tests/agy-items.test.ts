import { describe, expect, it } from "vitest";
import {
  agyFinalUsage,
  agyPlanToolUse,
  agyToolName,
  agyToolResult,
  agyToolUse,
  agyUsage,
  isAgySubagentCall,
  mergeAgyToolCall,
  pickPermissionOption,
  toolOutlivesPrompt,
  type AgyToolCall,
} from "../src/agy-items.js";

function call(update: Record<string, unknown>): AgyToolCall {
  return mergeAgyToolCall(undefined, update)!;
}

describe("agy tool names", () => {
  it("maps agy's tools to the shared names and keeps unknown ones", () => {
    const names: Array<[string, string]> = [
      ["run_command", "Bash"], ["view_file", "Read"], ["read_file", "Read"],
      ["write_to_file", "Write"], ["write_file", "Write"],
      ["replace_file_content", "Edit"], ["multi_replace_file_content", "Edit"], ["edit_file", "Edit"], ["sed_file", "Edit"],
      ["notebook_edit", "NotebookEdit"], ["grep_search", "Grep"], ["find_by_name", "Glob"], ["list_dir", "LS"],
      ["search_web", "WebSearch"], ["read_url_content", "WebFetch"], ["manage_task", "manage_task"],
    ];
    for (const [agy, shared] of names) {
      expect(agyToolName(call({ toolCallId: "c", name: agy, title: `Run ${agy}` }))).toBe(shared);
    }
    expect(agyToolName(call({ toolCallId: "c", name: "invoke_subagent", kind: "other", title: "Run invoke_subagent" }))).toBe("Agent");
  });
});

describe("agyToolUse and agyToolResult", () => {
  it("summarizes a shell command and flags a nonzero exit as an error", () => {
    const started = call({
      toolCallId: "call_1", name: "run_command", kind: "execute", title: "echo hi", status: "in_progress",
      rawInput: { CommandLine: "echo  hi\nthere" },
    });
    expect(agyToolUse(started)).toEqual({
      callId: "call_1", name: "Bash", summary: "echo hi there", input: { CommandLine: "echo  hi\nthere" },
    });
    expect(agyToolResult(started)).toBeUndefined();
    const done = mergeAgyToolCall(started, {
      toolCallId: "call_1", status: "completed", rawOutput: { output: "boom", exit_code: 1 },
    })!;
    expect(agyToolResult(done)).toEqual({
      callId: "call_1", content: { output: "boom", exit_code: 1 }, isError: true, structured: { output: "boom", exit_code: 1 },
    });
    // ACP's null means "unchanged", as an omitted field does.
    const kept = mergeAgyToolCall(done, { toolCallId: "call_1", status: "completed", rawOutput: null, content: null })!;
    expect(agyToolResult(kept)).toEqual(agyToolResult(done));
  });

  it("reads T3's other command spellings", () => {
    expect(agyToolUse(call({ toolCallId: "c", name: "run_command", kind: "execute", rawInput: { command_line: "ls" } })).summary).toBe("ls");
    expect(agyToolUse(call({ toolCallId: "c", name: "run_command", kind: "execute", args: { commandLine: "pwd" } })).summary).toBe("pwd");
  });

  it("uses the file path for file tools, the role for subagents, and the title otherwise", () => {
    expect(agyToolUse(call({
      toolCallId: "c", name: "read_file", kind: "read", title: "File ../../x/a.txt", locations: [{ path: "/x/a.txt" }],
    })).summary).toBe("/x/a.txt");
    expect(agyToolUse(call({
      toolCallId: "c", name: "invoke_subagent", kind: "other", title: "Run invoke_subagent", rawInput: { Role: "Fast Worker", Prompt: "p" },
    })).summary).toBe("Fast Worker");
    expect(agyToolUse(call({ toolCallId: "c", name: "grep_search", kind: "search", title: "Search for foo" })).summary).toBe("Search for foo");
    expect(agyToolUse(call({ toolCallId: "c", name: "manage_task", kind: "other", title: "Run manage_task" })).summary).toBeUndefined();
  });

  it("treats a failed status as an error", () => {
    const failed = call({ toolCallId: "c", name: "read_file", status: "failed", content: [{ type: "content" }] });
    expect(agyToolResult(failed)).toMatchObject({ callId: "c", isError: true, content: [{ type: "content" }] });
  });
});

describe("subagent and held-tool predicates", () => {
  it("recognizes subagent launches by T3's titles, not MCP calls", () => {
    for (const title of ["Running start_subagent", "Run start_subagent?", "Running invoke_subagent", "Run invoke_subagent?", "Run invoke_subagent"]) {
      expect(isAgySubagentCall(call({ toolCallId: "c", kind: "other", title }))).toBe(true);
    }
    expect(isAgySubagentCall(call({ toolCallId: "c", kind: "other", title: "Run invoke_subagent", _meta: { is_mcp_tool_call: true } }))).toBe(false);
    expect(isAgySubagentCall(call({ toolCallId: "c", kind: "execute", title: "Run invoke_subagent" }))).toBe(false);
  });

  it("holds commands that are not daemons, and schedule calls", () => {
    expect(toolOutlivesPrompt(call({ toolCallId: "c", kind: "execute", rawInput: { CommandLine: "sleep 5" } }))).toBe(true);
    expect(toolOutlivesPrompt(call({ toolCallId: "c", kind: "execute", rawInput: { CommandLine: "serve", IsDaemon: true } }))).toBe(false);
    expect(toolOutlivesPrompt(call({ toolCallId: "c", kind: "other", title: "Run schedule" }))).toBe(true);
    expect(toolOutlivesPrompt(call({ toolCallId: "c", kind: "read", title: "File x" }))).toBe(false);
  });
});

describe("agyPlanToolUse", () => {
  it("turns an ACP plan into a TodoWrite snapshot", () => {
    expect(agyPlanToolUse("s1", {
      sessionUpdate: "plan",
      entries: [
        { content: "Read", status: "completed", priority: "high" },
        { content: "Edit", status: "in_progress", priority: "high" },
        { content: "Test", status: "pending", priority: "low" },
      ],
    })).toEqual({
      callId: "s1:plan",
      name: "TodoWrite",
      summary: "1/3 steps completed",
      planItems: [
        { text: "Read", status: "completed" },
        { text: "Edit", status: "in_progress" },
        { text: "Test", status: "pending" },
      ],
      input: { entries: [
        { content: "Read", status: "completed", priority: "high" },
        { content: "Edit", status: "in_progress", priority: "high" },
        { content: "Test", status: "pending", priority: "low" },
      ] },
    });
    expect(agyPlanToolUse("s1", { sessionUpdate: "plan", entries: [] })).toBeUndefined();
  });
});

describe("usage", () => {
  it("reports context occupancy live and the response's counts at the end", () => {
    const live = agyUsage({ used: 10051, size: 1048576 }, "gemini-3.8-flash");
    expect(live).toEqual({
      contextTokens: 10051, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
      model: "gemini-3.8-flash", contextWindow: 1048576,
    });
    expect(agyFinalUsage(live, { inputTokens: 12036, outputTokens: 263, cachedReadTokens: 7656 }, "gemini-3.8-flash")).toEqual({
      contextTokens: 10051, inputTokens: 12036, cachedInputTokens: 7656, outputTokens: 263,
      model: "gemini-3.8-flash", contextWindow: 1048576,
    });
    expect(agyFinalUsage(undefined, undefined, undefined)).toBeUndefined();
  });
});

describe("pickPermissionOption", () => {
  const options = [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ];
  it("finds the option of a kind, falling back from always to once", () => {
    expect(pickPermissionOption(options, "reject_once")).toBe("deny");
    expect(pickPermissionOption(options, "allow_always")).toBe("allow");
    expect(pickPermissionOption(options, "reject_always")).toBe("deny");
    expect(pickPermissionOption([], "allow_once")).toBeUndefined();
  });
});
