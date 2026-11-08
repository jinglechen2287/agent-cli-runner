import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_FORK_CONFIG,
  createCodexAppServerClient,
  createCodexAppServerSession,
  runCodex,
  SteerRejectedError,
  type CodexAppServerSession,
} from "../src/index.js";
import { toolName } from "../src/codex-app-server.js";

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

describe("forked Codex side runs", () => {
  function forkServer(child: FakeChild, onTurnStart: (id: number | undefined) => void) {
    return captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "config/read") {
        send(child, {
          id: message.id,
          result: { config: { mcp_servers: { linear: { url: "https://mcp.example" }, probe: { command: "probe" } } } },
        });
      } else if (message.method === "thread/fork") {
        send(child, { id: message.id, result: { thread: { id: "fork-1" }, model: "gpt-test" } });
      } else if (message.method === "turn/start") {
        onTurnStart(message.id);
      } else if (message.method === "turn/interrupt") {
        send(child, { id: message.id, result: {} });
      }
    });
  }

  it("forks the thread ephemerally, read-only and tool-less, and answers on the fork", async () => {
    const child = makeFakeChild();
    const requests = forkServer(child, (id) => {
      send(child, { id, result: { turn: completedTurn("turn-1", "inProgress") } });
      send(child, {
        method: "item/completed",
        params: {
          threadId: "fork-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "message-1", text: "ZEBRA-4471" },
        },
      });
      send(child, {
        method: "turn/completed",
        params: { threadId: "fork-1", turn: completedTurn("turn-1") },
      });
    });

    const result = await runCodex({
      prompt: "what token?",
      cwd: "/tmp/project",
      isolated: true,
      forkSessionId: "parent-1",
      model: "gpt-test",
      spawnFn: (() => child) as never,
    });

    expect(requests.find(({ method }) => method === "config/read")?.params).toEqual({ cwd: "/tmp/project" });
    expect(requests.find(({ method }) => method === "thread/fork")?.params).toEqual({
      threadId: "parent-1",
      cwd: "/tmp/project",
      model: "gpt-test",
      ephemeral: true,
      excludeTurns: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      experimentalRawEvents: true,
      // Every configured MCP server is switched off by name: an empty table
      // would merge with the user's config and leave them all running.
      config: {
        ...CODEX_FORK_CONFIG,
        mcp_servers: { linear: { enabled: false }, probe: { enabled: false } },
      },
    });
    expect(requests.find(({ method }) => method === "turn/start")?.params)
      .toMatchObject({ threadId: "fork-1" });
    expect(result).toMatchObject({ text: "ZEBRA-4471", exitCode: 0, sessionId: "fork-1" });
  });

  it("interrupts and rejects a fork that starts a tool", async () => {
    const child = makeFakeChild();
    const requests = forkServer(child, (id) => {
      send(child, { id, result: { turn: completedTurn("turn-1", "inProgress") } });
      send(child, {
        method: "item/started",
        params: {
          threadId: "fork-1",
          turnId: "turn-1",
          item: { type: "commandExecution", id: "command-1", command: "ls", status: "inProgress" },
        },
      });
    });

    await expect(runCodex({
      prompt: "run ls",
      cwd: "/tmp/project",
      isolated: true,
      forkSessionId: "parent-1",
      spawnFn: (() => child) as never,
    })).rejects.toThrow(/Bash/);
    expect(requests.find(({ method }) => method === "turn/interrupt")?.params).toEqual({
      threadId: "fork-1",
      turnId: "turn-1",
    });
  });

  it("interrupts and rejects a fork that starts any item beyond a message or reasoning", async () => {
    const child = makeFakeChild();
    const requests = forkServer(child, (id) => {
      send(child, { id, result: { turn: completedTurn("turn-1", "inProgress") } });
      send(child, {
        method: "item/started",
        params: {
          threadId: "fork-1",
          turnId: "turn-1",
          item: { type: "collabAgentToolCall", id: "agent-1", tool: "spawnAgent", status: "inProgress" },
        },
      });
      send(child, {
        method: "turn/completed",
        params: { threadId: "fork-1", turn: completedTurn("turn-1") },
      });
    });

    await expect(runCodex({
      prompt: "spawn",
      cwd: "/tmp/project",
      isolated: true,
      forkSessionId: "parent-1",
      spawnFn: (() => child) as never,
    })).rejects.toThrow(/collabAgentToolCall/);
    expect(requests.some(({ method }) => method === "turn/interrupt")).toBe(true);
  });

  it("forks nothing when the config the fork must switch off can't be read", async () => {
    const child = makeFakeChild();
    const requests = captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "config/read") {
        send(child, { id: message.id, error: { code: -32603, message: "config unreadable" } });
      }
    });

    await expect(runCodex({
      prompt: "x",
      cwd: "/tmp/project",
      isolated: true,
      forkSessionId: "parent-1",
      spawnFn: (() => child) as never,
    })).rejects.toThrow(/config unreadable/);
    expect(requests.map(({ method }) => method)).toEqual(["initialize", "initialized", "config/read"]);
  });

  it("forks a guarded side run with the caller's sandbox, leaving its tools on", async () => {
    const child = makeFakeChild();
    const requests = forkServer(child, (id) => {
      send(child, { id, result: { turn: completedTurn("turn-1", "inProgress") } });
      for (const method of ["item/started", "item/completed"]) {
        send(child, {
          method,
          params: {
            threadId: "fork-1",
            turnId: "turn-1",
            item: {
              type: "commandExecution",
              id: "command-1",
              command: "head -1 notes.txt",
              cwd: "/tmp/project",
              status: method === "item/started" ? "inProgress" : "completed",
              aggregatedOutput: "first line",
              exitCode: 0,
            },
          },
        });
      }
      send(child, {
        method: "item/completed",
        params: { threadId: "fork-1", turnId: "turn-1", item: { type: "agentMessage", id: "m-1", text: "first line" } },
      });
      send(child, { method: "turn/completed", params: { threadId: "fork-1", turn: completedTurn("turn-1") } });
    });

    const result = await runCodex({
      prompt: "what's the first line of notes.txt?",
      cwd: "/tmp/project",
      forkSessionId: "parent-1",
      model: "gpt-test",
      developerInstructions: "answer once",
      sandboxPolicy: { type: "readOnly", networkAccess: true },
      spawnFn: (() => child) as never,
    });

    expect(requests.find(({ method }) => method === "thread/fork")?.params).toEqual({
      threadId: "parent-1",
      cwd: "/tmp/project",
      model: "gpt-test",
      developerInstructions: "answer once",
      ephemeral: true,
      excludeTurns: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      experimentalRawEvents: true,
    });
    expect(requests.find(({ method }) => method === "turn/start")?.params).toMatchObject({
      threadId: "fork-1",
      sandboxPolicy: { type: "readOnly", networkAccess: true },
    });
    expect(result).toMatchObject({ text: "first line", exitCode: 0 });
  });

  it("sends a guarded fork's config on thread/fork", async () => {
    const child = makeFakeChild();
    const requests = forkServer(child, (id) => {
      send(child, { id, result: { turn: completedTurn("turn-1", "inProgress") } });
      send(child, { method: "turn/completed", params: { threadId: "fork-1", turn: completedTurn("turn-1") } });
    });
    const forkConfig = { mcp_servers: { tools: { url: "http://127.0.0.1:1/mcp" } } };

    await runCodex({
      prompt: "x",
      cwd: "/tmp/project",
      forkSessionId: "parent-1",
      forkConfig,
      sandboxPolicy: { type: "readOnly", networkAccess: true },
      spawnFn: (() => child) as never,
    });

    expect(requests.find(({ method }) => method === "thread/fork")?.params).toMatchObject({
      threadId: "parent-1",
      sandbox: "read-only",
      config: forkConfig,
    });
  });

  it("takes fork config only on a guarded fork", async () => {
    const forkConfig = { mcp_servers: {} };
    await expect(runCodex({ prompt: "x", cwd: "/tmp", forkConfig })).rejects.toThrow(/guarded fork/i);
    await expect(runCodex({ prompt: "x", cwd: "/tmp", isolated: true, forkConfig })).rejects.toThrow(/guarded fork/i);
    await expect(runCodex({ prompt: "x", cwd: "/tmp", forkSessionId: "parent-1", isolated: true, forkConfig }))
      .rejects.toThrow(/guarded fork/i);
  });

  it("rejects options a guarded fork cannot take", async () => {
    const base = { prompt: "x", cwd: "/tmp", forkSessionId: "parent-1" };
    await expect(runCodex({ ...base, resumeSessionId: "thread-1" })).rejects.toThrow(/mutually exclusive/i);
    await expect(runCodex({ ...base, dangerouslyBypassApprovalsAndSandbox: true })).rejects.toThrow(/cannot bypass/i);
    await expect(runCodex({ ...base, turnCwd: "/tmp/canvas" })).rejects.toThrow(/turn cwd/i);
    for (const sandboxPolicy of [{ type: "workspaceWrite" }, { type: "dangerFullAccess" }] as const) {
      await expect(runCodex({ ...base, sandboxPolicy })).rejects.toThrow(/read-only sandbox/i);
    }
  });

  it("rejects fork options a side run cannot take", async () => {
    const base = { prompt: "x", cwd: "/tmp", forkSessionId: "parent-1" };
    await expect(runCodex({ ...base, isolated: true, resumeSessionId: "thread-1" }))
      .rejects.toThrow(/mutually exclusive/i);
    await expect(runCodex({ ...base, isolated: true, dangerouslyBypassApprovalsAndSandbox: true }))
      .rejects.toThrow(/cannot bypass/i);
    await expect(runCodex({ ...base, isolated: true, sandboxPolicy: { type: "dangerFullAccess" } }))
      .rejects.toThrow(/sandbox policy/i);
    await expect(runCodex({ ...base, isolated: true, turnCwd: "/tmp/canvas" }))
      .rejects.toThrow(/turn cwd/i);
  });
});

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
      // Input side only (cached included) — last.totalTokens also counts the
      // 10 output tokens and must not inflate context occupancy.
      contextTokens: 50,
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
      usage: expect.objectContaining({ contextTokens: 50 }),
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
      // Resumed threads keep raw events, so WebFetch URL enrichment does not
      // silently disappear after a resume.
      experimentalRawEvents: true,
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

  it("leaves a borrowed shared client running when turn/start goes unacked", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      captureRequests(child, (message) => {
        if (message.method === "initialize") {
          send(child, { id: message.id, result: {} });
        } else if (message.method === "thread/start") {
          send(child, { id: message.id, result: { thread: { id: "thread-shared" } } });
        }
        // turn/start never gets an ack: the runner must not retire a client
        // it borrowed — other threads may be mid-turn on it.
      });
      const client = await createCodexAppServerClient({
        cwd: "/tmp",
        spawnFn: (() => child) as never,
      });

      let settled: { status: string; error?: Error } | undefined;
      void runCodex({
        prompt: "x",
        cwd: "/tmp",
        appServerClient: client,
        timeoutMs: 1_000,
      }).then(
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
      expect(child.kill).not.toHaveBeenCalled();
      client.close();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards a per-turn sandboxPolicy override in turn/start", async () => {
    const child = makeFakeChild();
    let turnNumber = 0;
    const requests = captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-sbx" } } });
      } else if (message.method === "turn/start") {
        turnNumber += 1;
        const turnId = `turn-${turnNumber}`;
        send(child, { id: message.id, result: { turn: completedTurn(turnId, "inProgress") } });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-sbx",
            turnId,
            completedAtMs: turnNumber,
            item: { type: "agentMessage", id: `message-${turnNumber}`, text: `Done ${turnNumber}` },
          },
        });
        send(child, {
          method: "turn/completed",
          params: { threadId: "thread-sbx", turn: completedTurn(turnId) },
        });
      }
    });

    const session = await createCodexAppServerSession({
      cwd: "/tmp/project",
      dangerouslyBypassApprovalsAndSandbox: true,
      spawnFn: (() => child) as never,
    });

    await session.runTurn({
      prompt: "plan it",
      sandboxPolicy: { type: "readOnly", networkAccess: true },
    });
    await session.runTurn({
      prompt: "build it",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    await session.runTurn({ prompt: "no override" });

    const turnParams = requests
      .filter(({ method }) => method === "turn/start")
      .map(({ params }) => params);
    expect(turnParams[0]).toMatchObject({
      threadId: "thread-sbx",
      sandboxPolicy: { type: "readOnly", networkAccess: true },
    });
    expect(turnParams[1]).toMatchObject({
      threadId: "thread-sbx",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    expect(turnParams[2]).not.toHaveProperty("sandboxPolicy");
    await session.close();
  });

  it("moves one turn to turnCwd and returns the next to the session cwd", async () => {
    const child = makeFakeChild();
    let turnNumber = 0;
    const requests = captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-cwd" } } });
      } else if (message.method === "turn/start") {
        turnNumber += 1;
        const turnId = `turn-${turnNumber}`;
        // The first turn fails: the cwd still has to come back afterwards.
        if (turnNumber === 1) {
          send(child, { id: message.id, result: { turn: completedTurn(turnId, "failed") } });
          return;
        }
        send(child, { id: message.id, result: { turn: completedTurn(turnId, "inProgress") } });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-cwd",
            turnId,
            completedAtMs: turnNumber,
            item: { type: "agentMessage", id: `message-${turnNumber}`, text: `Done ${turnNumber}` },
          },
        });
        send(child, {
          method: "turn/completed",
          params: { threadId: "thread-cwd", turn: completedTurn(turnId) },
        });
      }
    });

    const session = await createCodexAppServerSession({
      cwd: "/tmp/project",
      dangerouslyBypassApprovalsAndSandbox: true,
      spawnFn: (() => child) as never,
    });

    await expect(session.runTurn({ prompt: "draw it", turnCwd: "/tmp/canvas" }))
      .resolves.toMatchObject({ exitCode: 1 });
    await session.runTurn({ prompt: "draw more", turnCwd: "/tmp/canvas" });
    await session.runTurn({ prompt: "build it" });

    const turnParams = requests
      .filter(({ method }) => method === "turn/start")
      .map(({ params }) => params);
    expect(turnParams.map((params) => params?.cwd))
      .toEqual(["/tmp/canvas", "/tmp/canvas", "/tmp/project"]);
    await session.close();
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

    const first = await session.runTurn({
      prompt: "one",
      model: "gpt-one",
      serviceTier: "priority",
    });
    const second = await session.runTurn({
      prompt: "two",
      model: "gpt-two",
      reasoningEffort: "medium",
      serviceTier: null,
    });

    expect(session.threadId).toBe("thread-session");
    expect(session.closed).toBe(false);
    expect(first).toMatchObject({ text: "Done 1", sessionId: "thread-session" });
    expect(second).toMatchObject({ text: "Done 2", sessionId: "thread-session" });
    expect(requests.filter(({ method }) => method === "initialize")).toHaveLength(1);
    expect(requests.filter(({ method }) => method === "thread/start")).toHaveLength(1);
    expect(requests.filter(({ method }) => method === "thread/resume")).toHaveLength(0);
    const turnParams = requests
      .filter(({ method }) => method === "turn/start")
      .map(({ params }) => params);
    expect(turnParams).toEqual([
      expect.objectContaining({
        threadId: "thread-session",
        model: "gpt-one",
        serviceTier: "priority",
      }),
      expect.objectContaining({
        threadId: "thread-session",
        model: "gpt-two",
        effort: "medium",
        serviceTier: null,
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
      steer: async () => {},
      compact: runTurn,
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

  it.each([undefined, "thread-old"])("sends config overrides on the thread request (resume: %s)", async (resumeSessionId) => {
    const config = { mcp_servers: { "agent-remote": { url: "http://127.0.0.1:1/mcp" } } };
    {
      const child = makeFakeChild();
      const requests = captureRequests(child, (message) => {
        if (message.method === "initialize") {
          send(child, { id: message.id, result: {} });
        } else if (message.method === "thread/start" || message.method === "thread/resume") {
          send(child, { id: message.id, result: { thread: { id: "thread-config" } } });
        }
      });
      const session = await createCodexAppServerSession({
        cwd: "/tmp/project",
        config,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        spawnFn: (() => child) as never,
      });
      const method = resumeSessionId ? "thread/resume" : "thread/start";
      expect(requests.find((request) => request.method === method)?.params)
        .toMatchObject({ cwd: "/tmp/project", config });
      await session.close();
    }
  });

  it("leaves config out of the thread request when none is given", async () => {
    const child = makeFakeChild();
    const requests = captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-plain" } } });
      }
    });
    const session = await createCodexAppServerSession({
      cwd: "/tmp/project",
      spawnFn: (() => child) as never,
    });
    expect(requests.find(({ method }) => method === "thread/start")?.params)
      .not.toHaveProperty("config");
    await session.close();
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
        // Word boundaries arrive as leading spaces and paragraph breaks as
        // whitespace-only chunks — both must survive verbatim or streamed
        // words jam together.
        delta({ threadId: "thread-1", turnId: "turn-1", itemId: "m1", delta: "Hel" });
        delta({ threadId: "thread-1", turnId: "turn-1", itemId: "m1", delta: "lo" });
        delta({ threadId: "thread-1", turnId: "turn-1", itemId: "m1", delta: " there" });
        delta({ threadId: "thread-1", turnId: "turn-1", itemId: "m1", delta: "\n\n" });
        delta({ threadId: "thread-1", turnId: "turn-1", itemId: "m1", delta: "friend" });
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
            item: { type: "agentMessage", id: "m1", text: "Hello there\n\nfriend" },
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

    expect(onAssistantTextDelta.mock.calls.map(([chunk]) => chunk))
      .toEqual(["Hel", "lo", " there", "\n\n", "friend"]);
    expect(onAssistantText).toHaveBeenCalledWith("Hello there\n\nfriend");
  });
});

describe("Codex app-server turn attribution", () => {
  it("ignores a trailing error notification tagged with another turn's id", async () => {
    const child = makeFakeChild();
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-1" } } });
      } else if (message.method === "turn/start") {
        send(child, { id: message.id, result: { turn: completedTurn("turn-2", "inProgress") } });
        // A late failure from an interrupted previous turn on this thread
        // must not settle the current turn.
        send(child, {
          method: "error",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            willRetry: false,
            error: { message: "rate limited" },
          },
        });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-2",
            completedAtMs: 2_000,
            item: { type: "agentMessage", id: "message-1", text: "Still healthy" },
          },
        });
        send(child, {
          method: "turn/completed",
          params: { threadId: "thread-1", turn: completedTurn("turn-2") },
        });
      }
    });

    await expect(runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    })).resolves.toMatchObject({ text: "Still healthy", exitCode: 0 });
  });

  it("fails fast when a thread-fatal error lands while turn/start is unacknowledged", async () => {
    const child = makeFakeChild();
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-1" } } });
      } else if (message.method === "turn/start") {
        // No ack, ever — only the fatal error. The run must reject with the
        // real error now, not a TimeoutError a minute later.
        send(child, {
          method: "error",
          params: {
            threadId: "thread-1",
            willRetry: false,
            error: { message: "thread wedged" },
          },
        });
      }
    });

    await expect(runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    })).rejects.toMatchObject({ name: "CodexTurnError", message: "Codex error: thread wedged" });
  });

  it("still fails the turn for an untagged (thread-fatal) error notification", async () => {
    const child = makeFakeChild();
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-1" } } });
      } else if (message.method === "turn/start") {
        send(child, { id: message.id, result: { turn: completedTurn("turn-1", "inProgress") } });
        send(child, {
          method: "error",
          params: {
            threadId: "thread-1",
            willRetry: false,
            error: { message: "auth expired" },
          },
        });
      }
    });

    await expect(runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    })).rejects.toMatchObject({ name: "CodexTurnError", message: "Codex error: auth expired" });
  });

  it("ignores turn-scoped notifications that arrive before turn/start is sent", async () => {
    const child = makeFakeChild();
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/resume") {
        send(child, { id: message.id, result: { thread: { id: "thread-9" } } });
        // Trailing completion of an aborted earlier turn, delivered while the
        // runner is still resuming — before this run's turn/start exists. It
        // must not latch as this run's turn.
        send(child, {
          method: "turn/completed",
          params: { threadId: "thread-9", turn: completedTurn("turn-old", "interrupted") },
        });
      } else if (message.method === "turn/start") {
        send(child, { id: message.id, result: { turn: completedTurn("turn-new", "inProgress") } });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-9",
            turnId: "turn-new",
            completedAtMs: 2_000,
            item: { type: "agentMessage", id: "message-1", text: "Fresh answer" },
          },
        });
        send(child, {
          method: "turn/completed",
          params: { threadId: "thread-9", turn: completedTurn("turn-new") },
        });
      }
    });

    await expect(runCodex({
      prompt: "x",
      cwd: "/tmp",
      resumeSessionId: "thread-9",
      spawnFn: (() => child) as never,
    })).resolves.toMatchObject({ text: "Fresh answer", exitCode: 0 });
  });

  it("ignores a stale completion arriving between turn/start and its ack", async () => {
    const child = makeFakeChild();
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/resume") {
        send(child, { id: message.id, result: { thread: { id: "thread-9" } } });
      } else if (message.method === "turn/start") {
        // Delivered before the ack: without pre-ack buffering this would
        // latch turn-old and settle the run as interrupted.
        send(child, {
          method: "turn/completed",
          params: { threadId: "thread-9", turn: completedTurn("turn-old", "interrupted") },
        });
        send(child, { id: message.id, result: { turn: completedTurn("turn-new", "inProgress") } });
        send(child, {
          method: "item/completed",
          params: {
            threadId: "thread-9",
            turnId: "turn-new",
            completedAtMs: 2_000,
            item: { type: "agentMessage", id: "message-1", text: "Fresh answer" },
          },
        });
        send(child, {
          method: "turn/completed",
          params: { threadId: "thread-9", turn: completedTurn("turn-new") },
        });
      }
    });

    await expect(runCodex({
      prompt: "x",
      cwd: "/tmp",
      resumeSessionId: "thread-9",
      spawnFn: (() => child) as never,
    })).resolves.toMatchObject({ text: "Fresh answer", exitCode: 0 });
  });

  it("settles with exitCode 1 when the turn/start ack already reports a terminal status", async () => {
    const child = makeFakeChild();
    captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-1" } } });
      } else if (message.method === "turn/start") {
        // Terminal ack with no follow-up notifications: the runner must not
        // wait for a turn/completed that will never arrive.
        send(child, { id: message.id, result: { turn: completedTurn("turn-1", "failed") } });
      }
    });

    await expect(runCodex({
      prompt: "x",
      cwd: "/tmp",
      spawnFn: (() => child) as never,
    })).resolves.toMatchObject({ exitCode: 1, sessionId: "thread-1" });
  });
});

describe("CodexAppServerSession.steer", () => {
  /** A session whose turn stays in progress until the test completes it. */
  async function steerableSession(options: {
    holdAck?: boolean;
    startError?: { code: number; message: string };
    steerError?: { code: number; message: string };
  } = {}) {
    const child = makeFakeChild();
    let ackTurn: (() => void) | undefined;
    const requests = captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "thread-steer" } } });
      } else if (message.method === "turn/start") {
        ackTurn = () => send(child, options.startError
          ? { id: message.id, error: options.startError }
          : { id: message.id, result: { turn: completedTurn("turn-1", "inProgress") } });
        if (!options.holdAck) ackTurn();
      } else if (message.method === "turn/steer") {
        if (options.steerError) {
          send(child, { id: message.id, error: options.steerError });
        } else {
          send(child, { id: message.id, result: { turnId: "turn-1" } });
        }
      }
    });
    const session = await createCodexAppServerSession({
      cwd: "/tmp/project",
      spawnFn: (() => child) as never,
    });
    const complete = (): void => {
      send(child, {
        method: "item/completed",
        params: {
          threadId: "thread-steer",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "m1", text: "Done" },
        },
      });
      send(child, {
        method: "turn/completed",
        params: { threadId: "thread-steer", turn: completedTurn("turn-1") },
      });
    };
    const waitForRequest = (method: string) =>
      vi.waitFor(() => {
        const found = requests.find((request) => request.method === method);
        if (!found) throw new Error(`no ${method} yet`);
        return found;
      });
    const close = async (): Promise<void> => {
      const closing = session.close();
      child.emit("close", 0);
      await closing;
    };
    return { child, session, requests, complete, waitForRequest, close, ack: () => ackTurn?.() };
  }

  it("steers the running turn with the expected turn id", async () => {
    const { session, complete, waitForRequest, child, close } = await steerableSession();
    const onToolUse = vi.fn();
    const onAssistantText = vi.fn();
    const turn = session.runTurn({ prompt: "one", onToolUse, onAssistantText });
    await waitForRequest("turn/start");
    await session.steer({ prompt: "also two" });
    const steer = await waitForRequest("turn/steer");
    expect(steer.params).toEqual({
      threadId: "thread-steer",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "also two", text_elements: [] }],
    });
    // The steered input comes back as a userMessage item; it is the user's
    // words, not a tool call or a reply.
    send(child, {
      method: "item/completed",
      params: {
        threadId: "thread-steer",
        turnId: "turn-1",
        item: { type: "userMessage", id: "u2", clientId: null, content: [{ type: "text", text: "also two", text_elements: [] }] },
      },
    });
    complete();
    await expect(turn).resolves.toMatchObject({ text: "Done" });
    expect(onToolUse).not.toHaveBeenCalled();
    expect(onAssistantText).toHaveBeenCalledTimes(1);
    await close();
  });

  it("waits for the turn id before steering", async () => {
    const { session, requests, complete, waitForRequest, ack, close } = await steerableSession({ holdAck: true });
    const turn = session.runTurn({ prompt: "one" });
    await waitForRequest("turn/start");
    const steered = session.steer({ prompt: "early" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests.some((request) => request.method === "turn/steer")).toBe(false);
    ack();
    await steered;
    expect((await waitForRequest("turn/steer")).params).toMatchObject({ expectedTurnId: "turn-1" });
    complete();
    await turn;
    await close();
  });

  it("rejects a steer the app-server refuses", async () => {
    const { session, complete, waitForRequest, close } = await steerableSession({
      steerError: { code: -32600, message: "no active turn to steer" },
    });
    const turn = session.runTurn({ prompt: "one" });
    await waitForRequest("turn/start");
    await expect(session.steer({ prompt: "late" })).rejects.toBeInstanceOf(SteerRejectedError);
    complete();
    await turn;
    await close();
  });

  it("rejects a steer with no turn running", async () => {
    const { session, complete, waitForRequest, close } = await steerableSession();
    await expect(session.steer({ prompt: "hello" })).rejects.toBeInstanceOf(SteerRejectedError);
    const turn = session.runTurn({ prompt: "one" });
    await waitForRequest("turn/start");
    complete();
    await turn;
    await expect(session.steer({ prompt: "after" })).rejects.toBeInstanceOf(SteerRejectedError);
    await close();
  });

  it("rejects a steer waiting on a turn whose start the app-server refuses", async () => {
    const { session, waitForRequest, ack, close } = await steerableSession({
      holdAck: true,
      startError: { code: -32602, message: "unknown model" },
    });
    const turn = session.runTurn({ prompt: "one" });
    await waitForRequest("turn/start");
    const steered = session.steer({ prompt: "early" });
    ack();
    await expect(turn).rejects.toThrow("unknown model");
    await expect(steered).rejects.toBeInstanceOf(SteerRejectedError);
    await close();
  });

  it("rejects a steer waiting on a turn that settles without an id", async () => {
    const { session, child, waitForRequest, close } = await steerableSession({ holdAck: true });
    const turn = session.runTurn({ prompt: "one" });
    await waitForRequest("turn/start");
    const steered = session.steer({ prompt: "early" });
    send(child, { method: "error", params: { threadId: "thread-steer", error: { message: "boom" } } });
    await expect(turn).rejects.toThrow("boom");
    await expect(steered).rejects.toBeInstanceOf(SteerRejectedError);
    await close();
  });
});

describe("Codex MCP tool names", () => {
  it("prefixes a tool with its server, in both item spellings", () => {
    expect(toolName({ type: "mcpToolCall", server: "probe", tool: "ask" })).toBe("mcp__probe__ask");
    expect(toolName({ type: "mcp_tool_call", server: "probe", tool: "ask" })).toBe("mcp__probe__ask");
  });

  it("falls back to the bare tool when no server is named", () => {
    expect(toolName({ type: "mcpToolCall", tool: "ask" })).toBe("ask");
    expect(toolName({ type: "mcpToolCall" })).toBe("MCP");
  });
});

describe("createCodexAppServerSession MCP", () => {
  const THREAD = "thread-mcp";
  const status = (name: string, state: string, extra: Record<string, unknown> = {}) => ({
    method: "mcpServer/startupStatus/updated",
    params: { threadId: THREAD, name, status: state, error: null, failureReason: null, ...extra },
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  /** A session whose turns stay open until `finish()`. */
  async function startSession(
    onThreadStart?: (child: FakeChild) => void,
    extra: Record<string, unknown> = {},
  ) {
    const child = makeFakeChild();
    child.kill = vi.fn(() => {
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      return true;
    });
    let turnNumber = 0;
    const requests = captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start" || message.method === "thread/resume") {
        onThreadStart?.(child);
        send(child, { id: message.id, result: { thread: { id: THREAD } } });
      } else if (message.method === "turn/start") {
        turnNumber += 1;
        send(child, { id: message.id, result: { turn: completedTurn(`turn-${turnNumber}`, "inProgress") } });
      }
    });
    const session = await createCodexAppServerSession({
      cwd: "/tmp/project",
      dangerouslyBypassApprovalsAndSandbox: true,
      spawnFn: (() => child) as never,
      ...extra,
    });
    const finish = () => send(child, {
      method: "turn/completed",
      params: { threadId: THREAD, turn: completedTurn(`turn-${turnNumber}`) },
    });
    const turnStarted = () => vi.waitFor(() => {
      expect(requests.some(({ method }) => method === "turn/start")).toBe(true);
    });
    const answerTo = (id: number) => vi.waitFor(() => {
      const found = requests.find((message) => message.id === id && message.method === undefined);
      if (!found) throw new Error("no answer yet");
      return found;
    });
    return { child, requests, session, finish, turnStarted, answerTo };
  }

  const elicitation = (id: number, params: Record<string, unknown> = {}) => ({
    id,
    method: "mcpServer/elicitation/request",
    params: {
      threadId: THREAD,
      turnId: "turn-1",
      serverName: "probe",
      _meta: null,
      message: "Who are you?",
      mode: "form",
      requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      ...params,
    },
  });

  it("asks Codex to surface forms, on the session's own thread and client only", async () => {
    const { requests, session } = await startSession();
    expect(requests.find(({ method }) => method === "initialize")?.params?.capabilities).toEqual({
      experimentalApi: true,
      extensions: { "openai/standard-form-input": {} },
    });
    expect(requests.find(({ method }) => method === "thread/start")?.params?.threadSource).toBe("user");
    await session.close();

    const resumed = await startSession(undefined, { resumeSessionId: THREAD });
    expect(resumed.requests.find(({ method }) => method === "thread/resume")?.params)
      .not.toHaveProperty("threadSource");
    await resumed.session.close();
  });

  it("leaves a plain run's capabilities alone", async () => {
    const child = makeFakeChild();
    const requests = captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: "t" } } });
      } else if (message.method === "turn/start") {
        send(child, { id: message.id, result: { turn: completedTurn("u", "inProgress") } });
        send(child, { method: "turn/completed", params: { threadId: "t", turn: completedTurn("u") } });
      }
    });
    await runCodex({ prompt: "x", cwd: "/tmp", spawnFn: (() => child) as never });
    expect(requests.find(({ method }) => method === "initialize")?.params?.capabilities)
      .toEqual({ experimentalApi: true });
    expect(requests.find(({ method }) => method === "thread/start")?.params)
      .not.toHaveProperty("threadSource");
  });

  it("applies startup status that arrived before the thread id, and ignores other threads", async () => {
    const { child, session, finish, turnStarted } = await startSession((c) => {
      send(c, status("early", "starting"));
      send(c, status("other", "failed", { threadId: "someone-else", error: "no" }));
    });
    await flush();
    const snapshots: unknown[] = [];
    const turn = session.runTurn({ prompt: "x", onMcpStatus: (servers) => snapshots.push(servers) });
    await turnStarted();
    expect(snapshots[0]).toEqual([{ name: "early", status: "connecting" }]);

    send(child, status("early", "ready"));
    send(child, status("bad", "failed", { error: "failed to start" }));
    send(child, status("gone", "cancelled"));
    send(child, status("other", "ready", { threadId: "someone-else" }));
    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toEqual([
        { name: "early", status: "connected" },
        { name: "bad", status: "failed", error: "failed to start" },
        { name: "gone", status: "failed" },
      ]);
    });
    finish();
    await turn;
    await session.close();
  });

  it("reports a server that needs signing in again as needs-auth", async () => {
    const { child, session, finish, turnStarted } = await startSession();
    const snapshots: unknown[] = [];
    const turn = session.runTurn({ prompt: "x", onMcpStatus: (servers) => snapshots.push(servers) });
    await turnStarted();
    send(child, status("linear", "failed", {
      error: "token expired",
      failureReason: "reauthenticationRequired",
    }));
    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toEqual([{ name: "linear", status: "needs-auth", error: "token expired" }]);
    });
    finish();
    await turn;
    await session.close();
  });

  it("sends the current snapshot at the start of a later turn", async () => {
    const { child, session, finish } = await startSession();
    const first = session.runTurn({ prompt: "x", onMcpStatus: () => {} });
    send(child, status("a", "ready"));
    await flush();
    await vi.waitFor(() => finish());
    await first;

    const snapshots: unknown[] = [];
    const second = session.runTurn({ prompt: "y", onMcpStatus: (servers) => snapshots.push(servers) });
    expect(snapshots[0]).toEqual([{ name: "a", status: "connected" }]);
    await flush();
    await vi.waitFor(() => finish());
    await second;
    await session.close();
  });

  it("hands a form to the running turn and answers Codex with the result", async () => {
    const { child, session, finish, turnStarted, answerTo } = await startSession();
    const onMcpElicitation = vi.fn(async () => ({ action: "accept" as const, content: { name: "Ada" } }));
    const turn = session.runTurn({ prompt: "x", onMcpElicitation });
    await turnStarted();
    send(child, elicitation(41));
    expect(await answerTo(41)).toMatchObject({ result: { action: "accept", content: { name: "Ada" } } });
    expect(onMcpElicitation).toHaveBeenCalledWith(
      {
        serverName: "probe",
        message: "Who are you?",
        mode: "form",
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    finish();
    await turn;
    await session.close();
  });

  it("hands over a URL request", async () => {
    const { child, session, finish, turnStarted, answerTo } = await startSession();
    const onMcpElicitation = vi.fn(async () => ({ action: "decline" as const }));
    const turn = session.runTurn({ prompt: "x", onMcpElicitation });
    await turnStarted();
    send(child, elicitation(42, { mode: "url", url: "https://example.com/x", elicitationId: "e" }));
    expect(await answerTo(42)).toMatchObject({ result: { action: "decline" } });
    expect(onMcpElicitation).toHaveBeenCalledWith(
      { serverName: "probe", message: "Who are you?", mode: "url", url: "https://example.com/x" },
      expect.anything(),
    );
    finish();
    await turn;
    await session.close();
  });

  it("declines other threads, unknown modes, and requests with no running turn", async () => {
    const { child, session, finish, turnStarted, answerTo } = await startSession();
    send(child, elicitation(43));
    expect(await answerTo(43)).toMatchObject({ result: { action: "decline" } });

    const onMcpElicitation = vi.fn(async () => ({ action: "accept" as const }));
    const turn = session.runTurn({ prompt: "x", onMcpElicitation });
    await turnStarted();
    send(child, elicitation(44, { threadId: "someone-else" }));
    expect(await answerTo(44)).toMatchObject({ result: { action: "decline" } });
    send(child, elicitation(45, { mode: "openaiForm" }));
    expect(await answerTo(45)).toMatchObject({ result: { action: "decline" } });
    send(child, elicitation(46, { mode: "openai/form" }));
    expect(await answerTo(46)).toMatchObject({ result: { action: "decline" } });
    expect(onMcpElicitation).not.toHaveBeenCalled();
    finish();
    await turn;
    await session.close();
  });

  it("declines with no callback, and cancels when it throws", async () => {
    const { child, session, finish, turnStarted, answerTo } = await startSession();
    const first = session.runTurn({ prompt: "x" });
    await turnStarted();
    send(child, elicitation(47));
    expect(await answerTo(47)).toMatchObject({ result: { action: "decline" } });
    finish();
    await first;

    const second = session.runTurn({
      prompt: "y",
      onMcpElicitation: async () => {
        throw new Error("boom");
      },
    });
    await flush();
    send(child, elicitation(48, { turnId: "turn-2" }));
    expect(await answerTo(48)).toMatchObject({ result: { action: "cancel" } });
    finish();
    await second;
    await session.close();
  });

  it("declines a late request from a turn that already ended", async () => {
    const { child, session, finish, turnStarted, answerTo, requests } = await startSession();
    const first = session.runTurn({ prompt: "x" });
    await turnStarted();
    finish();
    await first;

    const onMcpElicitation = vi.fn(async () => ({ action: "accept" as const }));
    const second = session.runTurn({ prompt: "y", onMcpElicitation });
    await vi.waitFor(() => {
      expect(requests.filter(({ method }) => method === "turn/start")).toHaveLength(2);
    });
    send(child, elicitation(53, { turnId: "turn-1" }));
    expect(await answerTo(53)).toMatchObject({ result: { action: "decline" } });
    expect(onMcpElicitation).not.toHaveBeenCalled();
    send(child, elicitation(54, { turnId: "turn-2" }));
    expect(await answerTo(54)).toMatchObject({ result: { action: "accept" } });
    finish();
    await second;
    await session.close();
  });

  it("cancels and aborts an open request when the turn settles", async () => {
    const { child, session, finish, turnStarted, answerTo } = await startSession();
    let seen: AbortSignal | undefined;
    const turn = session.runTurn({
      prompt: "x",
      onMcpElicitation: (_request, { signal }) => {
        seen = signal;
        return new Promise(() => {});
      },
    });
    await turnStarted();
    send(child, elicitation(49));
    await vi.waitFor(() => expect(seen).toBeDefined());
    finish();
    await turn;
    expect(await answerTo(49)).toMatchObject({ result: { action: "cancel" } });
    expect(seen?.aborted).toBe(true);
    await session.close();
  });

  it("ends a request Codex says is already resolved, leaving others open", async () => {
    const { child, session, finish, turnStarted, answerTo, requests } = await startSession();
    const signals = new Map<string, AbortSignal>();
    const turn = session.runTurn({
      prompt: "x",
      onMcpElicitation: (request, { signal }) => {
        signals.set(request.message, signal);
        return new Promise(() => {});
      },
    });
    await turnStarted();
    send(child, elicitation(51, { message: "first" }));
    send(child, elicitation(52, { message: "second" }));
    await vi.waitFor(() => expect(signals.size).toBe(2));

    send(child, {
      method: "serverRequest/resolved",
      params: { threadId: "someone-else", requestId: 51 },
    });
    await flush();
    expect(signals.get("first")?.aborted).toBe(false);

    send(child, { method: "serverRequest/resolved", params: { threadId: THREAD, requestId: 51 } });
    expect(await answerTo(51)).toMatchObject({ result: { action: "cancel" } });
    expect(signals.get("first")?.aborted).toBe(true);
    expect(signals.get("second")?.aborted).toBe(false);
    expect(requests.some((message) => message.id === 52 && message.method === undefined)).toBe(false);
    finish();
    await turn;
    await session.close();
  });

  it("keeps -32601 for every other server request", async () => {
    const { child, session, answerTo } = await startSession();
    send(child, { id: 50, method: "item/tool/requestUserInput", params: {} });
    expect(await answerTo(50)).toMatchObject({
      error: { code: -32601, message: "Unsupported server request: item/tool/requestUserInput" },
    });
    await session.close();
  });
});

describe("CodexAppServerSession.compact", () => {
  const THREAD = "thread-compact";
  /** A session whose `thread/compact/start` the test answers; `onCompact`
   * decides what the app-server does after it. */
  async function compactSession(onCompact: (child: FakeChild, id: number | undefined) => void) {
    const child = makeFakeChild();
    const requests = captureRequests(child, (message) => {
      if (message.method === "initialize") {
        send(child, { id: message.id, result: {} });
      } else if (message.method === "thread/start") {
        send(child, { id: message.id, result: { thread: { id: THREAD }, model: "gpt-test" } });
      } else if (message.method === "turn/start") {
        send(child, { id: message.id, result: { turn: completedTurn("turn-1", "inProgress") } });
        send(child, {
          method: "item/completed",
          params: { threadId: THREAD, turnId: "turn-1", item: { type: "agentMessage", id: "m1", text: "poem" } },
        });
        send(child, { method: "turn/completed", params: { threadId: THREAD, turn: completedTurn("turn-1") } });
      } else if (message.method === "thread/compact/start") {
        onCompact(child, message.id);
      } else if (message.method === "turn/interrupt") {
        send(child, { id: message.id, result: {} });
      }
    });
    const session = await createCodexAppServerSession({ cwd: "/tmp/project", spawnFn: (() => child) as never });
    return { child, session, requests };
  }

  const started = (turnId: string) => ({
    method: "turn/started",
    params: { threadId: THREAD, turn: completedTurn(turnId, "inProgress") },
  });
  const compaction = (method: "item/started" | "item/completed", turnId: string) => ({
    method,
    params: { threadId: THREAD, turnId, item: { type: "contextCompaction", id: "c1" } },
  });
  // As Codex 0.167 reports it: an estimate of the compacted history, with no
  // request behind it.
  const compactedUsage = (turnId: string) => ({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: THREAD,
      turnId,
      tokenUsage: {
        total: { totalTokens: 16_441, inputTokens: 16_371, cachedInputTokens: 12_160, outputTokens: 70 },
        last: { totalTokens: 20_864, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        modelContextWindow: 258_400,
      },
    },
  });
  const completed = (turnId: string, status = "completed") => ({
    method: "turn/completed",
    params: { threadId: THREAD, turn: completedTurn(turnId, status) },
  });

  it("compacts with thread/compact/start, taking the turn from turn/started", async () => {
    const { session, requests } = await compactSession((child, id) => {
      send(child, { id, result: {} });
      send(child, started("turn-c"));
      send(child, compaction("item/started", "turn-c"));
      send(child, compactedUsage("turn-c"));
      send(child, compaction("item/completed", "turn-c"));
      send(child, completed("turn-c"));
    });
    await session.runTurn({ prompt: "write a poem" });
    const onCompaction = vi.fn();
    const onUsage = vi.fn();
    const result = await session.compact({ onCompaction, onUsage });
    expect(requests.find((request) => request.method === "thread/compact/start")?.params).toEqual({ threadId: THREAD });
    expect(result).toMatchObject({ text: "", exitCode: 0, sessionId: THREAD });
    expect(onCompaction).toHaveBeenCalledWith({ trigger: "manual" });
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ contextTokens: 20_864, contextWindow: 258_400 }));
    expect(result.usage?.contextTokens).toBe(20_864);
  });

  it("takes the turn when turn/started arrives before the reply", async () => {
    const { session } = await compactSession((child, id) => {
      send(child, started("turn-c"));
      send(child, { id, result: {} });
      send(child, compaction("item/completed", "turn-c"));
      send(child, completed("turn-c"));
    });
    await expect(session.compact({})).resolves.toMatchObject({ exitCode: 0 });
  });

  it("ignores a late event from the previous turn while waiting for its own", async () => {
    const { session } = await compactSession((child, id) => {
      send(child, { id, result: {} });
      send(child, completed("turn-1"));
      send(child, started("turn-c"));
      send(child, completed("turn-c", "failed"));
    });
    await session.runTurn({ prompt: "write a poem" });
    await expect(session.compact({})).rejects.toThrow(/Codex turn failed/);
  });

  it("fails with Codex's error, and the session takes the next turn", async () => {
    let attempt = 0;
    const { session } = await compactSession((child, id) => {
      attempt += 1;
      send(child, { id, result: {} });
      const turnId = `turn-c${attempt}`;
      send(child, started(turnId));
      if (attempt === 1) {
        send(child, {
          method: "error",
          params: { threadId: THREAD, turnId, willRetry: false, error: { message: "Error running remote compact task" } },
        });
        send(child, completed(turnId, "failed"));
      } else {
        send(child, compaction("item/completed", turnId));
        send(child, completed(turnId));
      }
    });
    await expect(session.compact({})).rejects.toThrow(/Error running remote compact task/);
    expect(session.closed).toBe(false);
    await expect(session.compact({})).resolves.toMatchObject({ exitCode: 0 });
  });

  it("retires the session when the compaction never starts", async () => {
    vi.useFakeTimers();
    try {
      const { session, child } = await compactSession((c, id) => send(c, { id, result: {} }));
      let settled: { status: string; error?: Error } | undefined;
      void session.compact({ timeoutMs: 1_000 }).then(
        () => { settled = { status: "resolved" }; },
        (error: Error) => { settled = { status: "rejected", error }; },
      );
      await vi.advanceTimersByTimeAsync(1_500);
      expect(settled).toMatchObject({ status: "rejected", error: expect.objectContaining({ name: "TimeoutError" }) });
      expect(session.closed).toBe(true);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops before the turn is known by retiring the session", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { session, child } = await compactSession((c, id) => {
        send(c, { id, result: {} });
        queueMicrotask(() => controller.abort());
      });
      let settled: { status: string; error?: Error } | undefined;
      void session.compact({ signal: controller.signal }).then(
        () => { settled = { status: "resolved" }; },
        (error: Error) => { settled = { status: "rejected", error }; },
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toMatchObject({ status: "rejected", error: expect.objectContaining({ name: "AbortError" }) });
      expect(session.closed).toBe(true);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a running compaction with turn/interrupt", async () => {
    const controller = new AbortController();
    const { session, child, requests } = await compactSession((c, id) => {
      send(c, { id, result: {} });
      send(c, started("turn-c"));
      queueMicrotask(() => controller.abort());
    });
    const run = session.compact({ signal: controller.signal });
    const outcome = run.then(() => undefined, (error: Error) => error);
    await vi.waitFor(() => {
      if (!requests.some((request) => request.method === "turn/interrupt")) throw new Error("no interrupt yet");
    });
    expect(requests.find((request) => request.method === "turn/interrupt")?.params).toEqual({ threadId: THREAD, turnId: "turn-c" });
    send(child, completed("turn-c", "interrupted"));
    await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
  });

  it("cannot be steered", async () => {
    let finish: (() => void) | undefined;
    const { session } = await compactSession((child, id) => {
      send(child, { id, result: {} });
      send(child, started("turn-c"));
      finish = () => send(child, completed("turn-c"));
    });
    const run = session.compact({});
    await vi.waitFor(() => {
      if (!finish) throw new Error("not started");
    });
    await expect(session.steer({ prompt: "more" })).rejects.toBeInstanceOf(SteerRejectedError);
    finish?.();
    await run;
  });
});
