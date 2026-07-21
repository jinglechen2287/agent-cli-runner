import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createCodexAppServerClient, runCodex } from "../src/index.js";

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
      params: { capabilities: { experimentalApi: false } },
    });
    expect(requests).toContainEqual({ method: "initialized", params: {} });
    expect(requests.find(({ method }) => method === "thread/start")?.params).toMatchObject({
      cwd: "/tmp/project",
      model: "gpt-test",
      developerInstructions: "project rules",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
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

  it("maps web, plan, and collaboration notifications without rollout polling", async () => {
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
              query: "https://developers.openai.com/codex/app-server",
              action: {
                type: "open_page",
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
              query: "turn/start",
              action: {
                type: "find_in_page",
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
});
