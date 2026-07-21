import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createCodexAppServerClient,
  createCodexAppServerSession,
  runCodex,
  type CodexAppServerSession,
} from "../src/index.js";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

interface RpcMessage {
  id?: number | undefined;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function send(child: FakeChild, message: RpcMessage): void {
  child.stdout.write(`${JSON.stringify(message)}\n`);
}

function captureRequests(
  child: FakeChild,
  handle: (message: RpcMessage) => void,
): RpcMessage[] {
  const requests: RpcMessage[] = [];
  let buffer = "";
  child.stdin.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const message = JSON.parse(line) as RpcMessage;
      requests.push(message);
      handle(message);
    }
  });
  return requests;
}

function completedTurn(id: string, status = "completed") {
  return {
    id,
    items: [],
    itemsView: { type: "full" },
    status,
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1_000,
  };
}

describe("Codex app-server runner", () => {
  it("runs a new thread through app-server while preserving runner callbacks", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const onSessionId = vi.fn();
    const onAssistantText = vi.fn();
    const onToolUse = vi.fn();
    const onToolResult = vi.fn();
    const onUsage = vi.fn();
    const requests = captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: { userAgent: "codex-test" } });
      } else if (message.method === "thread/start") {
        send(child, {
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-test" },
        });
      } else if (message.method === "turn/start") {
        send(child, { id: message.id, result: { turn: completedTurn("turn-1", "inProgress") } });
        send(child, {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            startedAtMs: 1_000,
            item: {
              type: "commandExecution",
              id: "command-1",
              command: "pnpm test",
              cwd: "/tmp/project",
              status: "inProgress",
            },
          },
        });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            completedAtMs: 2_000,
            item: {
              type: "commandExecution",
              id: "command-1",
              command: "pnpm test",
              cwd: "/tmp/project",
              status: "completed",
              aggregatedOutput: "ok",
              exitCode: 0,
            },
          },
        });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            completedAtMs: 2_100,
            item: { type: "agentMessage", id: "message-1", text: "Done" },
          },
        });
        send(child, {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              total: {},
              last: {
                totalTokens: 60,
                inputTokens: 50,
                cachedInputTokens: 40,
                outputTokens: 10,
              },
              modelContextWindow: 200_000,
            },
          },
        });
        send(child, {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: completedTurn("turn-1") },
        });
      }
    });

    const result = await runCodex({
      prompt: "make it round",
      cwd: "/tmp/project",
      model: "gpt-test",
      developerInstructions: "project rules",
      dangerouslyBypassApprovalsAndSandbox: true,
      spawnFn: spawnFn as never,
      onSessionId,
      onAssistantText,
      onToolUse,
      onToolResult,
      onUsage,
    });

    expect(spawnFn).toHaveBeenCalledWith(
      "codex",
      ["app-server", "--stdio"],
      expect.objectContaining({ cwd: "/tmp/project", detached: process.platform !== "win32" }),
    );
    expect(requests[0]).toMatchObject({
      method: "initialize",
      params: { capabilities: { experimentalApi: true } },
    });
    expect(requests).toContainEqual({ method: "initialized", params: {} });
    expect(requests.find(({ method }) => method === "thread/start")?.params).toMatchObject({
      cwd: "/tmp/project",
      model: "gpt-test",
      developerInstructions: "project rules",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      experimentalRawEvents: true,
    });
    expect(requests.find(({ method }) => method === "turn/start")?.params).toMatchObject({
      threadId: "thread-1",
      input: [{ type: "text", text: "make it round", text_elements: [] }],
    });
    expect(onSessionId).toHaveBeenCalledWith("thread-1");
    expect(onAssistantText).toHaveBeenCalledWith("Done");
    expect(onToolUse).toHaveBeenCalledWith(expect.objectContaining({
      callId: "command-1",
      name: "Bash",
      summary: "pnpm test",
    }));
    expect(onToolResult).toHaveBeenCalledWith({
      callId: "command-1",
      content: expect.objectContaining({ aggregatedOutput: "ok", exitCode: 0 }),
    });
    expect(onUsage).toHaveBeenCalledWith({
      contextTokens: 60,
      inputTokens: 10,
      cachedInputTokens: 40,
      outputTokens: 10,
      model: "gpt-test",
      contextWindow: 200_000,
    });
    expect(result).toEqual({
      text: "Done",
      exitCode: 0,
      sessionId: "thread-1",
      usage: expect.objectContaining({ contextTokens: 60 }),
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("resumes a thread and interrupts only its active turn when aborted", async () => {
    const child = makeFakeChild();
    const controller = new AbortController();
    const requests = captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/resume") {
        send(child, { id: message.id, result: { thread: { id: "thread-2" }, model: "gpt-test" } });
      } else if (message.method === "turn/start") {
        send(child, { id: message.id, result: { turn: completedTurn("turn-2", "inProgress") } });
        queueMicrotask(() => controller.abort());
      } else if (message.method === "turn/interrupt") {
        send(child, { id: message.id, result: {} });
      }
    });

    const promise = runCodex({
      prompt: "continue",
      cwd: "/tmp/project",
      resumeSessionId: "thread-2",
      signal: controller.signal,
      spawnFn: (() => child) as never,
    });

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(requests.find(({ method }) => method === "thread/resume")?.params).toEqual({
      threadId: "thread-2",
      cwd: "/tmp/project",
    });
    expect(requests.find(({ method }) => method === "turn/interrupt")?.params).toEqual({
      threadId: "thread-2",
      turnId: "turn-2",
    });
  });

  it("waits for authoritative completed web items before mapping them", async () => {
    const child = makeFakeChild();
    const onToolUse = vi.fn();
    const onBackgroundAgentUpdate = vi.fn();
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-3" }, model: "gpt-test" } });
      } else if (message.method === "turn/start") {
        send(child, { id: message.id, result: { turn: completedTurn("turn-3", "inProgress") } });
        send(child, {
          method: "item/started",
          params: {
            threadId: "thread-3",
            turnId: "turn-3",
            startedAtMs: 1_000,
            item: {
              type: "webSearch",
              id: "web-1",
              query: "",
              action: null,
            },
          },
        });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-3",
            turnId: "turn-3",
            completedAtMs: 1_050,
            item: {
              type: "webSearch",
              id: "web-1",
              query: "codex app server",
              action: { type: "search", query: "codex app server" },
            },
          },
        });
        send(child, {
          method: "turn/plan/updated",
          params: {
            threadId: "thread-3",
            turnId: "turn-3",
            explanation: null,
            plan: [
              { step: "Inspect", status: "completed" },
              { step: "Implement", status: "inProgress" },
            ],
          },
        });
        send(child, {
          method: "item/started",
          params: {
            threadId: "thread-3",
            turnId: "turn-3",
            startedAtMs: 1_100,
            item: {
              type: "webSearch",
              id: "web-2",
              query: "",
              action: null,
            },
          },
        });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-3",
            turnId: "turn-3",
            completedAtMs: 1_150,
            item: {
              type: "webSearch",
              id: "web-2",
              query: "",
              action: {
                type: "openPage",
                url: "https://developers.openai.com/codex/app-server",
              },
            },
          },
        });
        send(child, {
          method: "item/started",
          params: {
            threadId: "thread-3",
            turnId: "turn-3",
            startedAtMs: 1_200,
            item: {
              type: "webSearch",
              id: "web-3",
              query: "",
              action: null,
            },
          },
        });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-3",
            turnId: "turn-3",
            completedAtMs: 1_250,
            item: {
              type: "webSearch",
              id: "web-3",
              query: "turn/start",
              action: {
                type: "findInPage",
                url: "https://developers.openai.com/codex/app-server",
                pattern: "turn/start",
              },
            },
          },
        });
        send(child, {
          method: "item/started",
          params: {
            threadId: "thread-3",
            turnId: "turn-3",
            startedAtMs: 2_000,
            item: {
              type: "collabAgentToolCall",
              id: "collab-1",
              tool: "spawnAgent",
              receiverThreadIds: ["agent-1"],
              prompt: "Inspect auth",
              agentsStates: { "agent-1": { status: "running", message: null } },
            },
          },
        });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-3",
            turnId: "turn-3",
            completedAtMs: 3_000,
            item: {
              type: "collabAgentToolCall",
              id: "collab-1",
              tool: "wait",
              receiverThreadIds: ["agent-1"],
              prompt: null,
              agentsStates: { "agent-1": { status: "completed", message: "Auth is sound" } },
            },
          },
        });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-3",
            turnId: "turn-3",
            completedAtMs: 3_100,
            item: { type: "agentMessage", id: "message-3", text: "Done" },
          },
        });
        send(child, {
          method: "turn/completed",
          params: { threadId: "thread-3", turn: completedTurn("turn-3") },
        });
      }
    });

    await runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onToolUse,
      onBackgroundAgentUpdate,
    });

    expect(onToolUse).toHaveBeenCalledWith(expect.objectContaining({
      callId: "web-1",
      name: "WebSearch",
      summary: "codex app server",
    }));
    expect(onToolUse).toHaveBeenCalledWith(expect.objectContaining({
      callId: "web-2",
      name: "WebFetch",
      summary: "https://developers.openai.com/codex/app-server",
      input: expect.objectContaining({
        url: "https://developers.openai.com/codex/app-server",
      }),
    }));
    expect(onToolUse).toHaveBeenCalledWith(expect.objectContaining({
      callId: "web-3",
      name: "WebFetch",
      summary: "turn/start · https://developers.openai.com/codex/app-server",
      input: expect.objectContaining({
        url: "https://developers.openai.com/codex/app-server",
        prompt: "Find turn/start in page",
      }),
    }));
    expect(onToolUse).toHaveBeenCalledWith(expect.objectContaining({
      name: "TodoWrite",
      summary: "1/2 steps completed",
      planItems: [
        { text: "Inspect", status: "completed" },
        { text: "Implement", status: "in_progress" },
      ],
    }));
    expect(onBackgroundAgentUpdate.mock.calls.map(([agent]) => agent)).toEqual([
      expect.objectContaining({
        id: "agent-1",
        parentToolCallId: "collab-1",
        description: "Inspect auth",
        status: "running",
        startedAt: 2_000,
      }),
      expect.objectContaining({
        id: "agent-1",
        description: "Inspect auth",
        status: "completed",
        summary: "Auth is sound",
        endedAt: 3_000,
      }),
    ]);
  });

  it("enriches hosted fetches and partial find actions from raw web outputs", async () => {
    const child = makeFakeChild();
    const callbacks: Array<{ type: "use" | "result"; value: unknown }> = [];
    const requests = captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, {
          id: message.id,
          result: { thread: { id: "thread-web-raw" }, model: "gpt-test" },
        });
      } else if (message.method === "turn/start") {
        send(child, {
          id: message.id,
          result: { turn: completedTurn("turn-web-raw", "inProgress") },
        });
        send(child, {
          method: "rawResponseItem/completed",
          params: {
            threadId: "thread-web-raw",
            turnId: "turn-web-raw",
            item: {
              type: "custom_tool_call",
              call_id: "raw-unrelated",
              name: "exec",
              input: "const r = await tools.exec_command({cmd:\"rg tools.web__run( src\"}); text(r)",
            },
          },
        });
        send(child, {
          method: "rawResponseItem/completed",
          params: {
            threadId: "thread-web-raw",
            turnId: "turn-web-raw",
            item: {
              type: "custom_tool_call",
              call_id: "raw-open",
              name: "exec",
              input: "const r = await tools.web__run({open:[{ref_id:\"https://example.test/wiki/Foo_(bar)\"}]}); text(r)",
            },
          },
        });
        send(child, {
          method: "item/started",
          params: {
            threadId: "thread-web-raw",
            turnId: "turn-web-raw",
            startedAtMs: 1_000,
            item: { type: "webSearch", id: "web-open", query: "", action: null },
          },
        });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-web-raw",
            turnId: "turn-web-raw",
            completedAtMs: 1_100,
            item: {
              type: "webSearch",
              id: "web-open",
              query: "",
              action: { type: "other" },
            },
          },
        });
        send(child, {
          method: "rawResponseItem/completed",
          params: {
            threadId: "thread-web-raw",
            turnId: "turn-web-raw",
            item: {
              type: "custom_tool_call_output",
              call_id: "raw-open",
              output: [
                { type: "input_text", text: "Script completed\nOutput:\n" },
                {
                  type: "input_text",
                  text: "Example page (https://example.test/wiki/Foo_(bar))\nSource: open",
                },
              ],
            },
          },
        });
        send(child, {
          method: "rawResponseItem/completed",
          params: {
            threadId: "thread-web-raw",
            turnId: "turn-web-raw",
            item: {
              type: "custom_tool_call",
              call_id: "raw-find",
              name: "exec",
              input: "const r = await tools.web__run({find:[{ref_id:\"turn1view0\",pattern:\"rawResponseItem/completed\"}]}); text(r)",
            },
          },
        });
        send(child, {
          method: "rawResponseItem/completed",
          params: {
            threadId: "thread-web-raw",
            turnId: "turn-web-raw",
            item: {
              type: "custom_tool_call_output",
              call_id: "raw-find",
              output: [{
                type: "input_text",
                text: "Codex app-server notes (https://github.com/openai/codex/blob/main/codex-rs/app-server/README_(draft).md)\nFind results",
              }],
            },
          },
        });
        send(child, {
          method: "item/started",
          params: {
            threadId: "thread-web-raw",
            turnId: "turn-web-raw",
            startedAtMs: 1_200,
            item: { type: "webSearch", id: "web-find", query: "", action: null },
          },
        });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-web-raw",
            turnId: "turn-web-raw",
            completedAtMs: 1_300,
            item: {
              type: "webSearch",
              id: "web-find",
              query: "rawResponseItem/completed",
              action: { type: "findInPage", url: null, pattern: "rawResponseItem/completed" },
            },
          },
        });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-web-raw",
            turnId: "turn-web-raw",
            completedAtMs: 1_400,
            item: { type: "agentMessage", id: "message-web-raw", text: "Done" },
          },
        });
        send(child, {
          method: "turn/completed",
          params: { threadId: "thread-web-raw", turn: completedTurn("turn-web-raw") },
        });
      }
    });

    await runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onToolUse: (value) => callbacks.push({ type: "use", value }),
      onToolResult: (value) => callbacks.push({ type: "result", value }),
    });

    expect(requests[0]).toMatchObject({
      method: "initialize",
      params: { capabilities: { experimentalApi: true } },
    });
    expect(requests.find(({ method }) => method === "thread/start")?.params)
      .toMatchObject({ experimentalRawEvents: true });
    expect(callbacks).toEqual([
      {
        type: "use",
        value: expect.objectContaining({
          callId: "web-open",
          name: "WebFetch",
          summary: "https://example.test/wiki/Foo_(bar)",
          input: expect.objectContaining({ url: "https://example.test/wiki/Foo_(bar)" }),
        }),
      },
      {
        type: "result",
        value: expect.objectContaining({
          callId: "web-open",
          content: expect.objectContaining({ url: "https://example.test/wiki/Foo_(bar)" }),
        }),
      },
      {
        type: "use",
        value: expect.objectContaining({
          callId: "web-find",
          name: "WebFetch",
          summary: "rawResponseItem/completed · https://github.com/openai/codex/blob/main/codex-rs/app-server/README_(draft).md",
          input: expect.objectContaining({
            url: "https://github.com/openai/codex/blob/main/codex-rs/app-server/README_(draft).md",
            prompt: "Find rawResponseItem/completed in page",
          }),
        }),
      },
      {
        type: "result",
        value: expect.objectContaining({
          callId: "web-find",
          content: expect.objectContaining({
            url: "https://github.com/openai/codex/blob/main/codex-rs/app-server/README_(draft).md",
          }),
        }),
      },
    ]);
  });

  it("does not guess a fetch URL when raw web call correlation is ambiguous", async () => {
    const child = makeFakeChild();
    const onToolUse = vi.fn();
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-web-ambiguous" } } });
      } else if (message.method === "turn/start") {
        send(child, {
          id: message.id,
          result: { turn: completedTurn("turn-web-ambiguous", "inProgress") },
        });
        for (const callId of ["raw-first", "raw-second"]) {
          send(child, {
            method: "rawResponseItem/completed",
            params: {
              threadId: "thread-web-ambiguous",
              turnId: "turn-web-ambiguous",
              item: {
                type: "custom_tool_call",
                call_id: callId,
                name: "exec",
                input: `const r = await tools.web__run({open:[{ref_id:\"${callId}\"}]}); text(r)`,
              },
            },
          });
        }
        send(child, {
          method: "item/started",
          params: {
            threadId: "thread-web-ambiguous",
            turnId: "turn-web-ambiguous",
            item: { type: "webSearch", id: "web-ambiguous", query: "", action: null },
          },
        });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-web-ambiguous",
            turnId: "turn-web-ambiguous",
            item: {
              type: "webSearch",
              id: "web-ambiguous",
              query: "",
              action: { type: "other" },
            },
          },
        });
        for (const [callId, url] of [
          ["raw-first", "https://first.test/"],
          ["raw-second", "https://second.test/"],
        ]) {
          send(child, {
            method: "rawResponseItem/completed",
            params: {
              threadId: "thread-web-ambiguous",
              turnId: "turn-web-ambiguous",
              item: {
                type: "custom_tool_call_output",
                call_id: callId,
                output: [{ type: "input_text", text: `Page (${url})` }],
              },
            },
          });
        }
        send(child, {
          method: "turn/completed",
          params: {
            threadId: "thread-web-ambiguous",
            turn: completedTurn("turn-web-ambiguous"),
          },
        });
      }
    });

    await runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onToolUse,
    });

    expect(onToolUse).toHaveBeenCalledTimes(1);
    expect(onToolUse.mock.calls[0]?.[0]).toEqual({
      callId: "web-ambiguous",
      name: "WebFetch",
      input: {
        type: "webSearch",
        id: "web-ambiguous",
        query: "",
        action: { type: "other" },
      },
    });
  });

  it("rejects unsupported native question requests instead of leaving a turn hung", async () => {
    const child = makeFakeChild();
    const requests = captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-4" }, model: "gpt-test" } });
      } else if (message.method === "turn/start") {
        send(child, { id: message.id, result: { turn: completedTurn("turn-4", "inProgress") } });
        send(child, {
          id: 99,
          method: "item/tool/requestUserInput",
          params: { threadId: "thread-4", turnId: "turn-4", itemId: "question-1" },
        });
      } else if (message.id === 99 && message.error !== undefined) {
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-4",
            turnId: "turn-4",
            completedAtMs: 2_000,
            item: { type: "agentMessage", id: "message-4", text: "Fallback" },
          },
        });
        send(child, {
          method: "turn/completed",
          params: { threadId: "thread-4", turn: completedTurn("turn-4") },
        });
      }
    });

    await expect(runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    })).resolves.toMatchObject({ text: "Fallback", exitCode: 0 });

    expect(requests).toContainEqual({
      id: 99,
      error: {
        code: -32601,
        message: "Unsupported server request: item/tool/requestUserInput",
      },
    });
  });

  it("routes concurrent turns over a reusable client and leaves its lifecycle to the owner", async () => {
    const child = makeFakeChild();
    let threadNumber = 0;
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        threadNumber += 1;
        send(child, {
          id: message.id,
          result: { thread: { id: `thread-${threadNumber}` }, model: "gpt-test" },
        });
      } else if (message.method === "turn/start") {
        const threadId = String(message.params?.threadId);
        const turnId = threadId.replace("thread", "turn");
        send(child, { id: message.id, result: { turn: completedTurn(turnId, "inProgress") } });
        send(child, {
          method: "item/completed",
          params: {
            threadId,
            turnId,
            completedAtMs: 2_000,
            item: { type: "agentMessage", id: `${turnId}-message`, text: `Done ${threadId}` },
          },
        });
        send(child, {
          method: "turn/completed",
          params: { threadId, turn: completedTurn(turnId) },
        });
      }
    });
    const client = await createCodexAppServerClient({
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });

    const [first, second] = await Promise.all([
      runCodex({ prompt: "one", cwd: "/tmp/one", appServerClient: client }),
      runCodex({ prompt: "two", cwd: "/tmp/two", appServerClient: client }),
    ]);

    expect(first).toMatchObject({ text: "Done thread-1", sessionId: "thread-1" });
    expect(second).toMatchObject({ text: "Done thread-2", sessionId: "thread-2" });
    expect(child.kill).not.toHaveBeenCalled();
    client.close();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("opens a thread once and reuses it for sequential session turns", async () => {
    const child = makeFakeChild();
    let turnNumber = 0;
    const requests = captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, {
          id: message.id,
          result: { thread: { id: "thread-session" }, model: "gpt-initial" },
        });
      } else if (message.method === "turn/start") {
        turnNumber += 1;
        const turnId = `turn-${turnNumber}`;
        send(child, { id: message.id, result: { turn: completedTurn(turnId, "inProgress") } });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-session",
            turnId,
            completedAtMs: turnNumber,
            item: { type: "agentMessage", id: `message-${turnNumber}`, text: `Done ${turnNumber}` },
          },
        });
        send(child, {
          method: "turn/completed",
          params: { threadId: "thread-session", turn: completedTurn(turnId) },
        });
      }
    });

    const session = await createCodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-initial",
      developerInstructions: "project rules",
      dangerouslyBypassApprovalsAndSandbox: true,
      spawnFn: (() => child) as never,
    });

    const first = await session.runTurn({ prompt: "one", model: "gpt-one" });
    const second = await session.runTurn({
      prompt: "two",
      model: "gpt-two",
      reasoningEffort: "medium",
    });

    expect(session.threadId).toBe("thread-session");
    expect(session.closed).toBe(false);
    expect(first).toMatchObject({ text: "Done 1", sessionId: "thread-session" });
    expect(second).toMatchObject({ text: "Done 2", sessionId: "thread-session" });
    expect(requests.filter(({ method }) => method === "initialize")).toHaveLength(1);
    expect(requests.filter(({ method }) => method === "thread/start")).toHaveLength(1);
    expect(requests.filter(({ method }) => method === "thread/resume")).toHaveLength(0);
    expect(requests.filter(({ method }) => method === "turn/start").map(({ params }) => params))
      .toEqual([
        expect.objectContaining({ threadId: "thread-session", model: "gpt-one" }),
        expect.objectContaining({
          threadId: "thread-session",
          model: "gpt-two",
          effort: "medium",
        }),
      ]);
    expect(child.kill).not.toHaveBeenCalled();

    const closing = Promise.resolve(session.close());
    let closeFinished = false;
    void closing.then(() => {
      closeFinished = true;
    });
    await Promise.resolve();
    expect(session.closed).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(closeFinished).toBe(false);
    child.emit("close", 0);
    await closing;
    expect(closeFinished).toBe(true);
  });

  it("resumes a session thread only once before running later turns", async () => {
    const child = makeFakeChild();
    let turnNumber = 0;
    const requests = captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/resume") {
        send(child, {
          id: message.id,
          result: { thread: { id: "thread-resumed" }, model: "gpt-test" },
        });
      } else if (message.method === "turn/start") {
        turnNumber += 1;
        const turnId = `resume-turn-${turnNumber}`;
        send(child, { id: message.id, result: { turn: completedTurn(turnId, "inProgress") } });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-resumed",
            turnId,
            item: { type: "agentMessage", id: `resume-message-${turnNumber}`, text: "Continued" },
          },
        });
        send(child, {
          method: "turn/completed",
          params: { threadId: "thread-resumed", turn: completedTurn(turnId) },
        });
      }
    });

    const session = await createCodexAppServerSession({
      cwd: "/tmp/project",
      resumeSessionId: "thread-resumed",
      spawnFn: (() => child) as never,
    });

    await session.runTurn({ prompt: "one" });
    await session.runTurn({ prompt: "two" });

    expect(requests.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
    expect(requests.filter(({ method }) => method === "thread/start")).toHaveLength(0);
    expect(requests.filter(({ method }) => method === "turn/start")).toHaveLength(2);
    const closing = Promise.resolve(session.close());
    child.emit("close", 0);
    await closing;
  });

  it("rejects cwd and resume options that conflict with a bound session", async () => {
    const runTurn = vi.fn(async () => ({
      text: "unexpected",
      exitCode: 0,
      sessionId: "thread-bound",
    }));
    const session: CodexAppServerSession = {
      threadId: "thread-bound",
      cwd: "/tmp/bound",
      closed: false,
      runTurn,
      onClose: () => () => {},
      close: async () => {},
    };

    await expect(runCodex({
      prompt: "wrong cwd",
      cwd: "/tmp/other",
      appServerSession: session,
    })).rejects.toThrow("cwd must match");
    await expect(runCodex({
      prompt: "wrong resume",
      cwd: "/tmp/bound",
      resumeSessionId: "thread-other",
      appServerSession: session,
    })).rejects.toThrow("cannot resume");
    for (const fixedOptions of [
      { developerInstructions: "different rules" },
      { dangerouslyBypassApprovalsAndSandbox: true },
      { env: { RUNNER_TEST: "1" } },
      { executablePath: "other-codex" },
      { spawnFn: (() => makeFakeChild()) as never },
    ]) {
      await expect(runCodex({
        prompt: "fixed option",
        cwd: "/tmp/bound",
        appServerSession: session,
        ...fixedOptions,
      })).rejects.toThrow("cannot override thread or client options");
    }
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("marks a session closed and notifies its owner when app-server exits", async () => {
    const child = makeFakeChild();
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-crash" } } });
      }
    });
    const session = await createCodexAppServerSession({
      cwd: "/tmp/project",
      spawnFn: (() => child) as never,
    });
    const onClose = vi.fn();
    session.onClose(onClose);

    child.emit("close", 9);

    expect(session.closed).toBe(true);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("exited with code 9"),
    }));
    await expect(session.runTurn({ prompt: "after crash" }))
      .rejects.toThrow("session is closed");
  });

  it("force-kills app-server when graceful session close does not exit", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      captureRequests(child, (message) => {
        if (message.method === "initialize") {
          send(child, { id: message.id, result: {} });
        } else if (message.method === "thread/start") {
          send(child, { id: message.id, result: { thread: { id: "thread-force-close" } } });
        }
      });
      const session = await createCodexAppServerSession({
        cwd: "/tmp/project",
        spawnFn: (() => child) as never,
      });

      const closing = session.close();
      let closeFinished = false;
      void closing.then(() => {
        closeFinished = true;
      });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      vi.advanceTimersByTime(2_100);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(closeFinished).toBe(false);
      vi.advanceTimersByTime(2_100);
      await closing;
      expect(closeFinished).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes an app-server exit that races with session creation", async () => {
    const child = makeFakeChild();
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-race" } } });
        child.emit("close", 9);
      }
    });

    const session = await createCodexAppServerSession({
      cwd: "/tmp/project",
      spawnFn: (() => child) as never,
    });

    expect(session.closed).toBe(true);
    await expect(session.runTurn({ prompt: "after race" }))
      .rejects.toThrow("session is closed");
  });

  it("does not spawn app-server for an already-aborted one-shot run", async () => {
    const spawnFn = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(runCodex({
      prompt: "x",
      cwd: "/tmp",
      signal: controller.signal,
      spawnFn: spawnFn as never,
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("rejects active turns when the owner closes a reusable client", async () => {
    const child = makeFakeChild();
    let resolveTurnStarted!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      resolveTurnStarted = resolve;
    });
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-close" } } });
      } else if (message.method === "turn/start") {
        send(child, { id: message.id, result: { turn: completedTurn("turn-close", "inProgress") } });
        resolveTurnStarted();
      }
    });
    const client = await createCodexAppServerClient({
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    });
    const run = runCodex({ prompt: "x", cwd: "/tmp", appServerClient: client });
    await turnStarted;

    client.close();

    await expect(run).rejects.toThrow("Codex app-server was closed");
  });

  it("interrupts a timed-out app-server turn and rejects with TimeoutError", async () => {
    const child = makeFakeChild();
    const requests = captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-timeout" } } });
      } else if (message.method === "turn/start") {
        send(child, { id: message.id, result: { turn: completedTurn("turn-timeout", "inProgress") } });
      } else if (message.method === "turn/interrupt") {
        send(child, { id: message.id, result: {} });
      }
    });

    await expect(runCodex({
      prompt: "x",
      cwd: "/tmp",
      timeoutMs: 10,
      spawnFn: (() => child) as never,
    })).rejects.toMatchObject({ name: "TimeoutError" });

    expect(requests.find(({ method }) => method === "turn/interrupt")?.params).toEqual({
      threadId: "thread-timeout",
      turnId: "turn-timeout",
    });
  });

  it("ignores stale notifications from the previous turn on a reused session", async () => {
    const child = makeFakeChild();
    const onToolUse = vi.fn();
    let turnNumber = 0;
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-stale" } } });
      } else if (message.method === "turn/start") {
        turnNumber += 1;
        if (turnNumber === 1) {
          send(child, { id: message.id, result: { turn: completedTurn("turn-1", "inProgress") } });
          send(child, {
            method: "item/completed",
            params: {
              threadId: "thread-stale",
              turnId: "turn-1",
              item: { type: "agentMessage", id: "message-1", text: "First done" },
            },
          });
          send(child, {
            method: "turn/completed",
            params: { threadId: "thread-stale", turn: completedTurn("turn-1") },
          });
          return;
        }
        // A late turn-1 notification lands before turn 2's start response.
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-stale",
            turnId: "turn-1",
            completedAtMs: 2_000,
            item: {
              type: "commandExecution",
              id: "stale-command",
              command: "echo stale",
              status: "completed",
              exitCode: 0,
            },
          },
        });
        send(child, { id: message.id, result: { turn: completedTurn("turn-2", "inProgress") } });
        setImmediate(() => {
          send(child, {
            method: "item/started",
            params: {
              threadId: "thread-stale",
              turnId: "turn-2",
              startedAtMs: 3_000,
              item: {
                type: "commandExecution",
                id: "fresh-command",
                command: "echo fresh",
                status: "inProgress",
              },
            },
          });
          send(child, {
            method: "item/completed",
            params: {
              threadId: "thread-stale",
              turnId: "turn-2",
              completedAtMs: 4_000,
              item: { type: "agentMessage", id: "message-2", text: "Second done" },
            },
          });
          send(child, {
            method: "turn/completed",
            params: { threadId: "thread-stale", turn: completedTurn("turn-2") },
          });
        });
      }
    });

    const session = await createCodexAppServerSession({
      cwd: "/tmp/project",
      spawnFn: (() => child) as never,
    });
    const first = await session.runTurn({ prompt: "one" });
    const second = await session.runTurn({ prompt: "two", onToolUse });

    expect(first).toMatchObject({ text: "First done" });
    expect(second).toMatchObject({ text: "Second done" });
    const toolCallIds = onToolUse.mock.calls.map(([info]) => info.callId);
    expect(toolCallIds).not.toContain("stale-command");
    expect(toolCallIds).toContain("fresh-command");
    const closing = Promise.resolve(session.close());
    child.emit("close", 0);
    await closing;
  });

  it("ignores stale notifications from any earlier turn on a reused session", async () => {
    const child = makeFakeChild();
    const onAssistantText = vi.fn();
    let turnNumber = 0;
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-older-stale" } } });
      } else if (message.method === "turn/start") {
        turnNumber += 1;
        const currentTurnId = `turn-${turnNumber}`;
        if (turnNumber < 3) {
          send(child, {
            id: message.id,
            result: { turn: completedTurn(currentTurnId, "inProgress") },
          });
          send(child, {
            method: "item/completed",
            params: {
              threadId: "thread-older-stale",
              turnId: currentTurnId,
              item: {
                type: "agentMessage",
                id: `message-${turnNumber}`,
                text: turnNumber === 1 ? "First done" : "Second done",
              },
            },
          });
          send(child, {
            method: "turn/completed",
            params: {
              threadId: "thread-older-stale",
              turn: completedTurn(currentTurnId),
            },
          });
          return;
        }

        // A notification from turn 1 arrives during turn 3. Tracking only
        // turn 2 as stale lets this old completion settle turn 3 early.
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-older-stale",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "very-stale-message",
              text: "Very stale",
            },
          },
        });
        send(child, {
          method: "turn/completed",
          params: {
            threadId: "thread-older-stale",
            turn: completedTurn("turn-1"),
          },
        });
        send(child, {
          id: message.id,
          result: { turn: completedTurn("turn-3", "inProgress") },
        });
        setImmediate(() => {
          send(child, {
            method: "item/completed",
            params: {
              threadId: "thread-older-stale",
              turnId: "turn-3",
              item: { type: "agentMessage", id: "message-3", text: "Third done" },
            },
          });
          send(child, {
            method: "turn/completed",
            params: {
              threadId: "thread-older-stale",
              turn: completedTurn("turn-3"),
            },
          });
        });
      }
    });

    const session = await createCodexAppServerSession({
      cwd: "/tmp/project",
      spawnFn: (() => child) as never,
    });
    await session.runTurn({ prompt: "one" });
    await session.runTurn({ prompt: "two" });
    onAssistantText.mockClear();
    const third = await session.runTurn({ prompt: "three", onAssistantText });

    expect(third).toMatchObject({ text: "Third done" });
    expect(onAssistantText).toHaveBeenCalledTimes(1);
    expect(onAssistantText).toHaveBeenCalledWith("Third done");
    const closing = Promise.resolve(session.close());
    child.emit("close", 0);
    await closing;
  });

  it("rejects an unanswered request with TimeoutError", async () => {
    const child = makeFakeChild();
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      }
    });
    const client = await createCodexAppServerClient({
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      requestTimeoutMs: 20,
    });

    await expect(client.request("model/list")).rejects.toMatchObject({
      name: "TimeoutError",
      message: expect.stringContaining("model/list"),
    });
    client.close();
  });

  it("gives turn/start more headroom than the default request timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const requests = captureRequests(child, (message) => {
        if (message.method === "initialize") {
          send(child, { id: message.id, result: {} });
        } else if (message.method === "thread/start") {
          send(child, { id: message.id, result: { thread: { id: "thread-slow" } } });
        } else if (message.method === "turn/start") {
          // The ack never arrives; only the started notification does.
          send(child, {
            method: "turn/started",
            params: { threadId: "thread-slow", turn: { id: "turn-slow", status: "inProgress" } },
          });
        } else if (message.method === "turn/interrupt") {
          send(child, { id: message.id, result: {} });
        }
      });

      let settled: { status: string; error?: Error } | undefined;
      void runCodex({ prompt: "x", cwd: "/tmp", spawnFn: (() => child) as never }).then(
        () => {
          settled = { status: "resolved" };
        },
        (error: Error) => {
          settled = { status: "rejected", error };
        },
      );

      await vi.advanceTimersByTimeAsync(15_000);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(50_000);
      expect(settled).toMatchObject({
        status: "rejected",
        error: expect.objectContaining({ name: "TimeoutError" }),
      });
      expect(requests.find(({ method }) => method === "turn/interrupt")?.params).toEqual({
        threadId: "thread-slow",
        turnId: "turn-slow",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the turn/start wait at the run timeout when the server stays silent", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      captureRequests(child, (message) => {
        if (message.method === "initialize") {
          send(child, { id: message.id, result: {} });
        } else if (message.method === "thread/start") {
          send(child, { id: message.id, result: { thread: { id: "thread-budget" } } });
        }
        // turn/start gets no ack and no turn/started notification.
      });

      let settled: { status: string; error?: Error } | undefined;
      void runCodex({
        prompt: "x",
        cwd: "/tmp",
        timeoutMs: 5_000,
        spawnFn: (() => child) as never,
      }).then(
        () => {
          settled = { status: "resolved" };
        },
        (error: Error) => {
          settled = { status: "rejected", error };
        },
      );

      await vi.advanceTimersByTimeAsync(5_500);
      expect(settled).toMatchObject({
        status: "rejected",
        error: expect.objectContaining({ name: "TimeoutError" }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires the session when turn/start times out before the turn is identified", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      captureRequests(child, (message) => {
        if (message.method === "initialize") {
          send(child, { id: message.id, result: {} });
        } else if (message.method === "thread/start") {
          send(child, { id: message.id, result: { thread: { id: "thread-wedged" } } });
        }
        // turn/start gets no ack and no turn/started notification, so the
        // possibly-running turn can never be interrupted by id.
      });
      const session = await createCodexAppServerSession({
        cwd: "/tmp/project",
        spawnFn: (() => child) as never,
      });

      let settled: { status: string; error?: Error } | undefined;
      void session.runTurn({ prompt: "x", timeoutMs: 1_000 }).then(
        () => {
          settled = { status: "resolved" };
        },
        (error: Error) => {
          settled = { status: "rejected", error };
        },
      );

      await vi.advanceTimersByTimeAsync(1_500);
      expect(settled).toMatchObject({
        status: "rejected",
        error: expect.objectContaining({ name: "TimeoutError" }),
      });
      expect(session.closed).toBe(true);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires the session when turn/start times out even with an identified turn", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const requests = captureRequests(child, (message) => {
        if (message.method === "initialize") {
          send(child, { id: message.id, result: {} });
        } else if (message.method === "thread/start") {
          send(child, { id: message.id, result: { thread: { id: "thread-half-wedged" } } });
        } else if (message.method === "turn/start") {
          // The started notification arrives but the ack never does.
          send(child, {
            method: "turn/started",
            params: {
              threadId: "thread-half-wedged",
              turn: { id: "turn-half-wedged", status: "inProgress" },
            },
          });
        } else if (message.method === "turn/interrupt") {
          send(child, { id: message.id, result: {} });
        }
      });
      const session = await createCodexAppServerSession({
        cwd: "/tmp/project",
        spawnFn: (() => child) as never,
      });

      let settled: { status: string; error?: Error } | undefined;
      void session.runTurn({ prompt: "x", timeoutMs: 1_000 }).then(
        () => {
          settled = { status: "resolved" };
        },
        (error: Error) => {
          settled = { status: "rejected", error };
        },
      );

      await vi.advanceTimersByTimeAsync(1_500);
      expect(settled).toMatchObject({
        status: "rejected",
        error: expect.objectContaining({ name: "TimeoutError" }),
      });
      expect(requests.find(({ method }) => method === "turn/interrupt")?.params).toEqual({
        threadId: "thread-half-wedged",
        turnId: "turn-half-wedged",
      });
      expect(session.closed).toBe(true);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts immediately when the signal fires before the turn is identified", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const controller = new AbortController();
      captureRequests(child, (message) => {
        if (message.method === "initialize") {
          send(child, { id: message.id, result: {} });
        } else if (message.method === "thread/start") {
          send(child, { id: message.id, result: { thread: { id: "thread-abort-early" } } });
        } else if (message.method === "turn/start") {
          // The server stays silent; the user aborts while the ack is pending.
          queueMicrotask(() => controller.abort());
        }
      });
      const session = await createCodexAppServerSession({
        cwd: "/tmp/project",
        spawnFn: (() => child) as never,
      });

      let settled: { status: string; error?: Error } | undefined;
      void session.runTurn({ prompt: "x", signal: controller.signal }).then(
        () => {
          settled = { status: "resolved" };
        },
        (error: Error) => {
          settled = { status: "rejected", error };
        },
      );

      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toMatchObject({
        status: "rejected",
        error: expect.objectContaining({ name: "AbortError" }),
      });
      expect(session.closed).toBe(true);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a non-retrying app-server error notification with CodexTurnError", async () => {
    const child = makeFakeChild();
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-error" } } });
      } else if (message.method === "turn/start") {
        send(child, { id: message.id, result: { turn: completedTurn("turn-error", "inProgress") } });
        send(child, {
          method: "error",
          params: {
            threadId: "thread-error",
            turnId: "turn-error",
            willRetry: false,
            error: { message: "rate limited" },
          },
        });
      }
    });

    await expect(runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    })).rejects.toMatchObject({ name: "CodexTurnError", message: "Codex error: rate limited" });
  });

  it("streams agent message deltas for the active turn and ignores foreign ones", async () => {
    const child = makeFakeChild();
    const onAssistantTextDelta = vi.fn();
    const onAssistantText = vi.fn();
    const delta = (params: Record<string, unknown>) => {
      send(child, { method: "item/agentMessage/delta", params });
    };
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-1" } } });
      } else if (message.method === "turn/start") {
        send(child, { id: message.id, result: { turn: completedTurn("turn-1", "inProgress") } });
        delta({ threadId: "thread-1", turnId: "turn-1", itemId: "m1", delta: "Hel" });
        delta({ threadId: "thread-1", turnId: "turn-1", itemId: "m1", delta: "lo" });
        // A pooled connection carries other threads' turns, and an interrupted
        // turn can trail deltas after the next one starts.
        delta({ threadId: "thread-2", turnId: "turn-9", itemId: "m9", delta: "other thread" });
        delta({ threadId: "thread-1", turnId: "turn-0", itemId: "m0", delta: "stale turn" });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            completedAtMs: 2_000,
            item: { type: "agentMessage", id: "m1", text: "Hello" },
          },
        });
        send(child, {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: completedTurn("turn-1") },
        });
      }
    });

    await runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
      onAssistantTextDelta,
      onAssistantText,
    });

    expect(onAssistantTextDelta.mock.calls.map(([chunk]) => chunk)).toEqual(["Hel", "lo"]);
    expect(onAssistantText).toHaveBeenCalledWith("Hello");
  });
});
