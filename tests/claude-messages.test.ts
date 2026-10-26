import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeTurnTranslator, type AgentCallbacks } from "../src/index.js";

function feed(callbacks: AgentCallbacks, messages: unknown[]) {
  const translator = createClaudeTurnTranslator(callbacks);
  for (const message of messages) translator.handle(message);
  return translator;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createClaudeTurnTranslator", () => {
  it("emits the session id from the system.init event and returns it in the outcome", () => {
    const onSessionId = vi.fn();
    const t = feed({ onSessionId }, [
      { type: "system", subtype: "init", session_id: "sess-1" },
    ]);
    expect(onSessionId).toHaveBeenCalledWith("sess-1");
    expect(onSessionId).toHaveBeenCalledTimes(1);
    expect(t.finish().sessionId).toBe("sess-1");
  });

  it("deduplicates the session id across init and result within one turn", () => {
    const onSessionId = vi.fn();
    const t = feed({ onSessionId }, [
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "result", subtype: "success", result: "ok", session_id: "sess-1" },
    ]);
    expect(onSessionId).toHaveBeenCalledTimes(1);
    expect(t.finish().sessionId).toBe("sess-1");
  });

  it("emits assistant text via onAssistantText", () => {
    const onAssistantText = vi.fn();
    feed({ onAssistantText }, [
      { type: "assistant", message: { content: [{ type: "text", text: "Hello there" }] } },
    ]);
    expect(onAssistantText).toHaveBeenCalledWith("Hello there");
  });

  it("ignores non-object input", () => {
    const onAssistantText = vi.fn();
    const t = feed({ onAssistantText }, [
      null,
      "x",
      42,
      ["assistant"],
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
    ]);
    expect(onAssistantText).toHaveBeenCalledTimes(1);
    expect(onAssistantText).toHaveBeenCalledWith("ok");
    expect(t.done).toBe(false);
  });

  it("emits text deltas in order and still reports the completed message", () => {
    const onAssistantTextDelta = vi.fn();
    const onAssistantText = vi.fn();
    feed({ onAssistantTextDelta, onAssistantText }, [
      ...["Hello", " there"].map((text) => ({
        type: "stream_event",
        event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
      })),
      { type: "assistant", message: { content: [{ type: "text", text: "Hello there" }] } },
    ]);
    expect(onAssistantTextDelta.mock.calls.map(([chunk]) => chunk)).toEqual(["Hello", " there"]);
    expect(onAssistantText).toHaveBeenCalledWith("Hello there");
  });

  // Extended thinking and streamed tool input share the content_block_delta
  // envelope; only text_delta belongs in the transcript.
  it("ignores thinking, signature, and tool-input deltas", () => {
    const onAssistantTextDelta = vi.fn();
    const deltas = [
      { type: "thinking_delta", thinking: "pondering" },
      { type: "signature_delta", signature: "sig" },
      { type: "input_json_delta", partial_json: '{"a":' },
    ];
    feed(
      { onAssistantTextDelta },
      deltas.map((delta) => ({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta },
      })),
    );
    expect(onAssistantTextDelta).not.toHaveBeenCalled();
  });

  // Background subagents stream through the parent's output tagged with the
  // spawning tool call; their prose is not the parent turn's transcript.
  it("ignores text deltas emitted by a background subagent", () => {
    const onAssistantTextDelta = vi.fn();
    feed({ onAssistantTextDelta }, [
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "subagent prose" },
        },
        parent_tool_use_id: "toolu_123",
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "main prose" },
        },
        parent_tool_use_id: null,
      },
    ]);
    expect(onAssistantTextDelta.mock.calls.map(([chunk]) => chunk)).toEqual(["main prose"]);
  });

  it("keeps subagent prose out of onAssistantText and the final text fallback", () => {
    const onAssistantText = vi.fn();
    const onToolUse = vi.fn();
    const t = feed({ onAssistantText, onToolUse }, [
      { type: "assistant", message: { content: [{ type: "text", text: "parent" }] } },
      // The subagent's completed message arrives after the parent's; its tool
      // calls still belong in the parent transcript, but its prose does not.
      {
        type: "assistant",
        parent_tool_use_id: "toolu_1",
        message: {
          content: [
            { type: "text", text: "subagent prose" },
            { type: "tool_use", id: "toolu_sub", name: "Read", input: { file_path: "/tmp/a" } },
          ],
        },
      },
      // No `result` string on the result event: the fallback must be the
      // parent's last message, not the subagent's.
      { type: "result", session_id: "s1" },
    ]);
    expect(onAssistantText.mock.calls.map(([message]) => message)).toEqual(["parent"]);
    expect(onToolUse).toHaveBeenCalledWith(expect.objectContaining({ callId: "toolu_sub" }));
    expect(t.finish().text).toBe("parent");
  });

  it("emits full lifecycle snapshots for background subagents", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const onBackgroundAgentUpdate = vi.fn();
    const t = createClaudeTurnTranslator({ onBackgroundAgentUpdate });

    t.handle({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "tool-1",
      description: "Inspect authentication",
      task_type: "local_agent",
    });
    vi.setSystemTime(2_000);
    t.handle({
      type: "system",
      subtype: "task_progress",
      task_id: "task-1",
      tool_use_id: "tool-1",
      description: "Inspect authentication",
      subagent_type: "Explore",
      usage: { total_tokens: 1200, tool_uses: 4, duration_ms: 900 },
      last_tool_name: "Grep",
      summary: "Found the session middleware",
    });
    vi.setSystemTime(2_500);
    t.handle({
      type: "system",
      subtype: "task_progress",
      task_id: "task-1",
      usage: { duration_ms: 1_400 },
    });
    vi.setSystemTime(3_000);
    t.handle({
      type: "system",
      subtype: "task_updated",
      task_id: "task-1",
      patch: { status: "completed", end_time: 2_900 },
    });
    vi.setSystemTime(4_000);
    t.handle({
      type: "system",
      subtype: "task_updated",
      task_id: "task-1",
      patch: { status: "completed", end_time: 3_900 },
    });

    const base = {
      id: "task-1",
      provider: "claude",
      parentToolCallId: "tool-1",
      description: "Inspect authentication",
      startedAt: 1_000,
    };
    const progressed = {
      ...base,
      agentType: "Explore",
      summary: "Found the session middleware",
    };
    expect(onBackgroundAgentUpdate.mock.calls).toEqual([
      [{ ...base, agentType: "local_agent", status: "running", updatedAt: 1_000 }],
      [{
        ...progressed,
        status: "running",
        progress: { totalTokens: 1200, toolUses: 4, durationMs: 900, lastToolName: "Grep" },
        updatedAt: 2_000,
      }],
      [{
        ...progressed,
        status: "running",
        progress: { totalTokens: 1200, toolUses: 4, durationMs: 1_400, lastToolName: "Grep" },
        updatedAt: 2_500,
      }],
      [{
        ...progressed,
        status: "completed",
        progress: { totalTokens: 1200, toolUses: 4, durationMs: 1_400, lastToolName: "Grep" },
        updatedAt: 3_000,
        endedAt: 2_900,
      }],
      [{
        ...progressed,
        status: "completed",
        progress: { totalTokens: 1200, toolUses: 4, durationMs: 1_400, lastToolName: "Grep" },
        updatedAt: 4_000,
        endedAt: 2_900,
      }],
    ]);
  });

  it("contains background-agent callback errors", () => {
    const t = createClaudeTurnTranslator({
      onBackgroundAgentUpdate: () => {
        throw new Error("host callback failed");
      },
    });
    expect(() => t.handle({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      description: "Inspect authentication",
      task_type: "local_agent",
    })).not.toThrow();
  });

  it("does not report background shell tasks as background agents", () => {
    const onBackgroundAgentUpdate = vi.fn();
    feed({ onBackgroundAgentUpdate }, [{
      type: "system",
      subtype: "task_started",
      task_id: "bash-1",
      description: "Run tests",
      task_type: "local_bash",
    }]);
    expect(onBackgroundAgentUpdate).not.toHaveBeenCalled();
  });

  it("recognizes an older untyped task by its Agent tool correlation", () => {
    const onBackgroundAgentUpdate = vi.fn();
    feed({ onBackgroundAgentUpdate }, [
      {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "tool-legacy",
            name: "Agent",
            input: { description: "Inspect authentication" },
          }],
        },
      },
      {
        type: "system",
        subtype: "task_started",
        task_id: "task-legacy",
        tool_use_id: "tool-legacy",
        description: "Inspect authentication",
      },
      {
        type: "system",
        subtype: "task_updated",
        task_id: "task-legacy",
        patch: { status: "killed", error: "Stopped by parent" },
      },
    ]);
    expect(onBackgroundAgentUpdate).toHaveBeenCalledTimes(2);
    expect(onBackgroundAgentUpdate.mock.calls[1]?.[0]).toMatchObject({
      id: "task-legacy",
      parentToolCallId: "tool-legacy",
      status: "interrupted",
      error: "Stopped by parent",
      endedAt: expect.any(Number),
    });
  });

  it("concatenates multiple text blocks in one assistant message", () => {
    const onAssistantText = vi.fn();
    feed({ onAssistantText }, [{
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Part one. " },
          { type: "text", text: "Part two." },
        ],
      },
    }]);
    expect(onAssistantText).toHaveBeenCalledWith("Part one. Part two.");
  });

  it("returns the result event's text and session id", () => {
    const t = feed({}, [
      { type: "assistant", message: { content: [{ type: "text", text: "Working on it" }] } },
      { type: "result", result: "Final answer", session_id: "sess-9" },
    ]);
    expect(t.finish()).toEqual({
      text: "Final answer",
      sessionId: "sess-9",
      isError: false,
      errors: [],
    });
  });

  it("falls back to the last assistant text when no result event arrives", () => {
    const t = feed(
      {},
      ["First message", "Second message"].map((text) => ({
        type: "assistant",
        message: { content: [{ type: "text", text }] },
      })),
    );
    expect(t.finish().text).toBe("Second message");
  });

  it("emits tool_use events via onToolUse", () => {
    const onToolUse = vi.fn();
    feed({ onToolUse }, [{
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/Button.tsx" } },
        ],
      },
    }]);
    expect(onToolUse).toHaveBeenCalledWith({
      callId: "t1",
      name: "Edit",
      summary: "src/Button.tsx",
      input: { file_path: "src/Button.tsx" },
    });
  });

  it("summarizes each known tool by its most identifying input field", () => {
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
      { name: "Skill", input: { skill: "linear", args: "list" }, summary: "linear · list" },
      { name: "mcp__linear__create_issue", input: { title: "Bug" }, summary: undefined },
    ];

    for (const c of cases) {
      const onToolUse = vi.fn();
      feed({ onToolUse }, [{
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t", name: c.name, input: c.input }] },
      }]);
      expect(onToolUse).toHaveBeenCalledWith({
        callId: "t",
        name: c.name,
        ...(c.summary !== undefined ? { summary: c.summary } : {}),
        input: c.input,
      });
    }
  });

  it("normalizes Claude TodoWrite todos into a plan snapshot", () => {
    const onToolUse = vi.fn();
    feed({ onToolUse }, [{
      type: "assistant",
      message: {
        content: [{
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
        }],
      },
    }]);
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

  it("leaves an empty TodoWrite without a plan snapshot", () => {
    const onToolUse = vi.fn();
    feed({ onToolUse }, [{
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t", name: "TodoWrite", input: { todos: [] } }] },
    }]);
    expect(onToolUse).toHaveBeenCalledWith({ callId: "t", name: "TodoWrite", input: { todos: [] } });
  });

  it("collapses a multiline command into a one-line summary", () => {
    const onToolUse = vi.fn();
    feed({ onToolUse }, [{
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t", name: "Bash", input: { command: "pnpm build\n  && pnpm test" } },
        ],
      },
    }]);
    expect(onToolUse).toHaveBeenCalledWith({
      callId: "t",
      name: "Bash",
      summary: "pnpm build && pnpm test",
      input: { command: "pnpm build\n  && pnpm test" },
    });
  });

  it("omits the summary when the input field is empty or whitespace", () => {
    const onToolUse = vi.fn();
    feed({ onToolUse }, [{
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "   " } }] },
    }]);
    expect(onToolUse).toHaveBeenCalledWith({ callId: "t", name: "Bash", input: { command: "   " } });
  });

  it("emits Claude tool results with their matching call id", () => {
    const onToolResult = vi.fn();
    feed({ onToolResult }, [{
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "task-create-1",
          content: "Task #7 created successfully: Ship task indicators",
          is_error: false,
        }],
      },
    }]);
    expect(onToolResult).toHaveBeenCalledWith({
      callId: "task-create-1",
      content: "Task #7 created successfully: Ship task indicators",
      isError: false,
    });
  });

  it("emits normalized usage per assistant message, summing input and cache lanes", () => {
    const onUsage = vi.fn();
    feed({ onUsage }, [{
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
    }]);
    expect(onUsage).toHaveBeenCalledWith({
      contextTokens: 2 + 15099 + 6490,
      inputTokens: 2,
      cachedInputTokens: 15099,
      outputTokens: 6,
      model: "claude-opus-4-8",
      contextWindow: 200_000,
    });
  });

  it("re-attaches the init line's variant marker to live per-message usage", () => {
    const onUsage = vi.fn();
    // Claude Code names the qualified model once, on the init line, and strips
    // the marker on every assistant message. Guessing the window from the
    // stripped id reads a 1M session as 200k for the whole turn.
    feed({ onUsage }, [
      { type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-4-8[1m]" },
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 2, cache_read_input_tokens: 15099, output_tokens: 6 },
        },
      },
    ]);
    expect(onUsage).toHaveBeenCalledWith({
      contextTokens: 2 + 15099,
      inputTokens: 2,
      cachedInputTokens: 15099,
      outputTokens: 6,
      model: "claude-opus-4-8[1m]",
      contextWindow: 1_000_000,
    });
  });

  it("keeps a different model's own id rather than the session model's marker", () => {
    const onUsage = vi.fn();
    feed({ onUsage }, [
      { type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-4-8[1m]" },
      // A turn that switched models: the marker belongs to the session model,
      // not to whatever else answered.
      {
        type: "assistant",
        message: {
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 2, output_tokens: 6 },
        },
      },
    ]);
    expect(onUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5-20251001", contextWindow: 200_000 }),
    );
  });

  it("ignores a subagent's usage — it occupies its own context, not the turn's", () => {
    const onUsage = vi.fn();
    const t = feed({ onUsage }, [
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-8[1m]",
          content: [{ type: "text", text: "parent" }],
          usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 6 },
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "toolu_1",
        message: {
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "text", text: "subagent" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: "result",
        result: "done",
        session_id: "s1",
        usage: { input_tokens: 11, cache_read_input_tokens: 90, output_tokens: 7 },
        modelUsage: {
          "claude-haiku-4-5-20251001": { contextWindow: 200_000 },
          "claude-opus-4-8[1m]": { contextWindow: 1_000_000 },
        },
      },
    ]);
    expect(onUsage).toHaveBeenCalledWith({
      contextTokens: 100,
      inputTokens: 10,
      cachedInputTokens: 90,
      outputTokens: 6,
      model: "claude-opus-4-8[1m]",
      contextWindow: 1_000_000,
    });
    // The subagent answered last, but it must not become the model the result
    // event attributes the turn's occupancy to.
    expect(t.finish().usage).toMatchObject({
      contextTokens: 100,
      model: "claude-opus-4-8[1m]",
      contextWindow: 1_000_000,
    });
  });

  it("corrects the window from the result event's authoritative modelUsage and returns it", () => {
    const onUsage = vi.fn();
    // A turn that also billed a small sub-agent model (Haiku): the primary
    // model is the one that produced the final assistant message.
    const t = feed({ onUsage }, [
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 2, cache_read_input_tokens: 15099, output_tokens: 6 },
        },
      },
      {
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
      },
    ]);
    const finalUsage = {
      contextTokens: 2 + 15099,
      inputTokens: 2,
      cachedInputTokens: 15099,
      outputTokens: 6,
      model: "claude-opus-4-8[1m]",
      contextWindow: 1_000_000,
    };
    expect(onUsage).toHaveBeenLastCalledWith(finalUsage);
    expect(t.finish().usage).toEqual(finalUsage);
  });

  it("keeps the last per-message occupancy at result instead of the turn's cumulative totals", () => {
    // A two-request turn. The result event's usage sums both requests, so it
    // does NOT describe context occupancy — the last message's usage does.
    const t = feed({}, [
      {
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
      },
      {
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
      },
      {
        type: "result",
        result: "done",
        usage: {
          input_tokens: 18,
          cache_creation_input_tokens: 5060,
          cache_read_input_tokens: 39616,
          output_tokens: 285,
        },
        modelUsage: { "claude-opus-4-8[1m]": { contextWindow: 1_000_000 } },
      },
    ]);
    expect(t.finish().usage).toEqual({
      contextTokens: 8 + 280 + 22198,
      inputTokens: 8,
      cachedInputTokens: 22198,
      outputTokens: 195,
      model: "claude-opus-4-8[1m]",
      contextWindow: 1_000_000,
    });
  });

  it("ignores a malformed modelUsage contextWindow and falls back to the family rule", () => {
    const t = feed({}, [
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      },
      {
        type: "result",
        result: "hi",
        usage: { input_tokens: 5, output_tokens: 3 },
        modelUsage: { "claude-opus-4-8": { contextWindow: "huge" } },
      },
    ]);
    expect(t.finish().usage).toMatchObject({ model: "claude-opus-4-8", contextWindow: 200_000 });
  });

  it("attributes result usage to the responding model even when its message carried no usage", () => {
    // A tool-only assistant message: it names the responding model but omits
    // usage. Its model must still win over the larger-window model at result.
    const t = feed({}, [
      {
        type: "assistant",
        message: {
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "a.ts" } }],
        },
      },
      {
        type: "result",
        result: "done",
        usage: { input_tokens: 5, output_tokens: 3 },
        modelUsage: {
          "claude-haiku-4-5-20251001": { contextWindow: 200_000 },
          "claude-opus-4-8[1m]": { contextWindow: 1_000_000 },
        },
      },
    ]);
    expect(t.finish().usage).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      contextWindow: 200_000,
    });
  });

  it("attributes a reply-less result to the session's model, not a tied helper model", () => {
    // Claude Code makes small Haiku calls of its own, listed first in
    // modelUsage with the same window: with no reply to name the model, the
    // init line's model must win the tie.
    const onUsage = vi.fn();
    const t = feed({ onUsage }, [
      { type: "system", subtype: "init", session_id: "s", model: "claude-opus-5-5[1m]" },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [],
        usage: { input_tokens: 12, output_tokens: 0 },
        modelUsage: {
          "claude-haiku-5-5": { contextWindow: 1_000_000 },
          "claude-opus-5-5[1m]": { contextWindow: 1_000_000 },
        },
      },
    ]);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(t.finish().usage).toMatchObject({ model: "claude-opus-5-5[1m]", contextWindow: 1_000_000 });
  });

  it("prefers the exact session model over a same-base variant listed first", () => {
    const t = feed({}, [
      { type: "system", subtype: "init", session_id: "s", model: "claude-opus-5-5[1m]" },
      {
        type: "result",
        result: "",
        usage: { input_tokens: 12, output_tokens: 0 },
        modelUsage: {
          "claude-opus-5-5": { contextWindow: 200_000 },
          "claude-opus-5-5[1m]": { contextWindow: 1_000_000 },
        },
      },
    ]);
    expect(t.finish().usage).toMatchObject({ model: "claude-opus-5-5[1m]", contextWindow: 1_000_000 });
  });

  it("reports no usage for a reply-less result that counted no tokens", () => {
    // A turn stopped before any output: its zeroed usage would otherwise
    // overwrite the thread's real context occupancy with nothing.
    const onUsage = vi.fn();
    const t = feed({ onUsage }, [
      { type: "system", subtype: "init", session_id: "s", model: "claude-opus-5-5[1m]" },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {
          "claude-haiku-5-5": { contextWindow: 1_000_000 },
          "claude-opus-5-5[1m]": { contextWindow: 1_000_000 },
        },
      },
    ]);
    expect(onUsage).not.toHaveBeenCalled();
    expect(t.finish().usage).toBeUndefined();
  });

  it("omits usage from the outcome when the CLI reports no token counts", () => {
    const t = feed({}, [
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
    ]);
    expect(t.finish().usage).toBeUndefined();
  });
});

describe("createClaudeTurnTranslator task tracking", () => {
  it("tracks every started task until it settles", () => {
    const t = createClaudeTurnTranslator({});
    for (const [taskId, taskType] of [
      ["bash-1", "local_bash"],
      ["bash-2", "local_bash"],
      ["agent-1", "local_agent"],
      ["monitor-1", "monitor"],
      ["agent-2", "local_agent"],
      ["agent-3", "local_agent"],
      ["agent-4", "local_agent"],
    ] as const) {
      t.handle({ type: "system", subtype: "task_started", task_id: taskId, task_type: taskType });
    }
    expect([...t.liveTaskIds].sort()).toEqual([
      "agent-1", "agent-2", "agent-3", "agent-4", "bash-1", "bash-2", "monitor-1",
    ]);

    t.handle({ type: "system", subtype: "task_notification", task_id: "bash-1", status: "completed" });
    t.handle({ type: "system", subtype: "task_notification", task_id: "bash-2", status: "failed" });
    t.handle({ type: "system", subtype: "task_notification", task_id: "monitor-1", status: "stopped" });
    t.handle({ type: "system", subtype: "task_updated", task_id: "agent-1", patch: { status: "completed" } });
    t.handle({ type: "system", subtype: "task_updated", task_id: "agent-2", patch: { status: "failed" } });
    t.handle({ type: "system", subtype: "task_updated", task_id: "agent-3", patch: { status: "killed" } });
    // A non-terminal update leaves the task live.
    t.handle({ type: "system", subtype: "task_updated", task_id: "agent-4", patch: { status: "running" } });

    expect([...t.liveTaskIds]).toEqual(["agent-4"]);
  });

  it("flips done only once the result arrives", () => {
    const t = createClaudeTurnTranslator({});
    t.handle({ type: "system", subtype: "init", session_id: "s" });
    t.handle({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    t.handle({ type: "system", subtype: "task_started", task_id: "x", task_type: "local_bash" });
    expect(t.done).toBe(false);
    t.handle({ type: "result", subtype: "success", result: "hi", session_id: "s" });
    expect(t.done).toBe(true);
  });
});

describe("createClaudeTurnTranslator prompt correlation", () => {
  const ours = (text: string) => ({
    type: "result",
    subtype: "success",
    result: text,
    session_id: "s",
    user_message_uuid: "u1",
    user_message_uuids: ["u1"],
  });

  it("ignores an empty result that arrives before any output of the prompt", () => {
    const t = createClaudeTurnTranslator({}, { promptUuid: "u1" });
    t.handle({ type: "result", subtype: "success", result: "", session_id: "orphan" });
    expect(t.done).toBe(false);
    t.handle({ type: "assistant", message: { content: [{ type: "text", text: "PONG" }] } });
    t.handle(ours("PONG"));
    expect(t.done).toBe(true);
    expect(t.finish()).toMatchObject({ text: "PONG", isError: false, sessionId: "s" });
  });

  it("ignores a result that names other prompts", () => {
    const t = createClaudeTurnTranslator({}, { promptUuid: "u1" });
    t.handle({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["not mine"],
      user_message_uuids: ["u0"],
    });
    expect(t.done).toBe(false);
    t.handle(ours("mine"));
    expect(t.finish()).toMatchObject({ text: "mine", isError: false, errors: [] });
  });

  it("ignores an un-echoed result once the CLI is known to echo prompt uuids", () => {
    const t = createClaudeTurnTranslator({}, { promptUuid: "u1", cliEchoesPromptUuid: true });
    t.handle({ type: "assistant", message: { content: [{ type: "text", text: "re: notification" }] } });
    t.handle({ type: "result", subtype: "success", result: "re: notification", session_id: "s" });
    expect(t.done).toBe(false);
    t.handle(ours("mine"));
    expect(t.done).toBe(true);
    expect(t.echoedPromptUuid).toBe(true);
  });

  it("accepts an un-echoed, non-empty result from a CLI that does not echo", () => {
    const t = createClaudeTurnTranslator({}, { promptUuid: "u1" });
    t.handle({ type: "result", subtype: "success", result: "done", session_id: "s" });
    expect(t.done).toBe(true);
    expect(t.echoedPromptUuid).toBe(false);
  });

  it("waits past its result for a live background agent and its follow-up", () => {
    const t = createClaudeTurnTranslator({}, { promptUuid: "u1" });
    t.handle({ type: "system", subtype: "task_started", task_id: "agent-1", task_type: "local_agent" });
    t.handle({ type: "system", subtype: "task_started", task_id: "bash-1", task_type: "local_bash" });
    t.handle(ours("launched"));
    expect(t.done).toBe(false);
    expect(t.awaitingFollowUp).toBe(false);
    expect([...t.liveAgentTaskIds]).toEqual(["agent-1"]);

    t.handle({ type: "system", subtype: "task_updated", task_id: "agent-1", patch: { status: "completed" } });
    t.handle({ type: "system", subtype: "task_notification", task_id: "agent-1", status: "completed" });
    expect(t.done).toBe(false);
    expect(t.awaitingFollowUp).toBe(true);
    expect(t.liveAgentTaskIds.size).toBe(0);

    t.handle({ type: "assistant", message: { content: [{ type: "text", text: "the plan" }] } });
    t.handle({ type: "result", subtype: "success", result: "the plan", session_id: "s" });
    expect(t.done).toBe(true);
    expect(t.awaitingFollowUp).toBe(false);
    expect(t.finish()).toMatchObject({ text: "the plan", isError: false });
    // A shell does not hold the turn; the host decides what to do with it.
    expect([...t.liveTaskIds]).toEqual(["bash-1"]);
  });

  it("ignores a follow-up result that names another prompt", () => {
    const t = createClaudeTurnTranslator({}, { promptUuid: "u1" });
    t.handle({ type: "system", subtype: "task_started", task_id: "agent-1", task_type: "local_agent" });
    t.handle(ours("launched"));
    t.handle({ type: "system", subtype: "task_notification", task_id: "agent-1", status: "completed" });
    t.handle({ type: "result", subtype: "success", result: "not mine", user_message_uuids: ["u2"] });
    expect(t.done).toBe(false);
    expect(t.awaitingFollowUp).toBe(true);
    t.handle({ type: "result", subtype: "success", result: "the plan", session_id: "s" });
    expect(t.done).toBe(true);
    expect(t.finish().text).toBe("the plan");
  });

  it("keeps the last non-empty result text when a follow-up result is empty", () => {
    const t = createClaudeTurnTranslator({}, { promptUuid: "u1" });
    t.handle({ type: "system", subtype: "task_started", task_id: "agent-1", task_type: "local_agent" });
    t.handle(ours("launched"));
    t.handle({ type: "system", subtype: "task_notification", task_id: "agent-1", status: "completed" });
    t.handle({ type: "result", subtype: "success", result: "", session_id: "s" });
    expect(t.done).toBe(true);
    expect(t.finish().text).toBe("launched");
  });

  it("needs no follow-up for an agent that settled before the result", () => {
    const t = createClaudeTurnTranslator({}, { promptUuid: "u1" });
    t.handle({ type: "system", subtype: "task_started", task_id: "agent-1", task_type: "local_agent" });
    t.handle({ type: "system", subtype: "task_notification", task_id: "agent-1", status: "completed" });
    t.handle(ours("done"));
    expect(t.done).toBe(true);
  });
});

describe("createClaudeTurnTranslator error results", () => {
  it("reports an error result's messages rather than earlier assistant text", () => {
    const t = feed({}, [
      { type: "assistant", message: { content: [{ type: "text", text: "Working on it" }] } },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["boom", "bang"],
        session_id: "s",
      },
    ]);
    expect(t.finish()).toMatchObject({
      isError: true,
      errors: ["boom", "bang"],
      text: "boom\nbang",
      sessionId: "s",
    });
  });

  it("treats a success-subtype result flagged is_error as a failure", () => {
    const t = feed({}, [
      { type: "result", subtype: "success", is_error: true, result: "API Error: x", session_id: "s" },
    ]);
    expect(t.finish()).toMatchObject({ isError: true, errors: [], text: "API Error: x" });
  });

  it("reports a successful result as no error", () => {
    const t = feed({}, [
      { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s" },
    ]);
    expect(t.finish()).toMatchObject({ isError: false, errors: [], text: "done" });
  });
});

describe("createClaudeTurnTranslator robustness", () => {
  it("contains a throwing host callback and still produces the outcome", () => {
    const onAssistantText = vi.fn(() => {
      throw new Error("host bug");
    });
    const onToolUse = vi.fn(() => {
      throw new Error("host bug");
    });
    // Async rejection must be contained too — Node turns an unhandled
    // rejection into a process crash just like a synchronous throw.
    const onUsage = vi.fn(async () => {
      throw new Error("host bug");
    });
    const t = feed({ onAssistantText, onToolUse, onUsage }, [{
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
          { type: "text", text: "done" },
        ],
        usage: { input_tokens: 10 },
      },
    }]);
    expect(onToolUse).toHaveBeenCalledTimes(1);
    expect(onAssistantText).toHaveBeenCalledWith("done");
    expect(onUsage).toHaveBeenCalledTimes(1);
    const outcome = t.finish();
    expect(outcome.text).toBe("done");
    expect(outcome.usage).toMatchObject({ inputTokens: 10 });
  });

  it("does not resurrect a finished background agent from a trailing progress rollup", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const onBackgroundAgentUpdate = vi.fn();
    feed({ onBackgroundAgentUpdate }, [
      { type: "system", subtype: "task_started", task_id: "task-1", task_type: "local_agent" },
      {
        type: "system",
        subtype: "task_updated",
        task_id: "task-1",
        patch: { status: "completed", end_time: 900 },
      },
      {
        type: "system",
        subtype: "task_progress",
        task_id: "task-1",
        usage: { total_tokens: 2_000 },
      },
    ]);
    const last = onBackgroundAgentUpdate.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({
      id: "task-1",
      status: "completed",
      endedAt: 900,
      progress: { totalTokens: 2_000 },
    });
  });
});
