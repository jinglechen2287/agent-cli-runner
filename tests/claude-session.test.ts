import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AbortError,
  createClaudeSession,
  MissingCliError,
  runClaude,
  SteerRejectedError,
  TimeoutError,
  type ClaudeQuery,
  type ClaudeQueryFn,
  type CreateClaudeSessionOptions,
} from "../src/index.js";

/** A real executable for path resolution; the fake query never runs it. */
const EXECUTABLE = process.execPath;

interface FakeQuery {
  queryFn: ClaudeQueryFn;
  /** Options the session handed to query(). */
  options(): Parameters<ClaudeQueryFn>[0]["options"];
  /** Prompts the session sent, in order. */
  prompts: string[];
  /** The uuid stamped on each prompt the session sent, in order. */
  uuids: Array<string | undefined>;
  /** The priority on each prompt the session sent, in order. */
  priorities: Array<string | undefined>;
  /** Resolves once the session has sent its nth prompt (1-based). */
  waitForPrompt(count: number): Promise<void>;
  emit(message: unknown): void;
  /** End the message stream, as when the CLI exits. */
  end(): void;
  /** Make the message stream throw. */
  fail(error: Error): void;
  interrupt: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  mcpServerStatus: ReturnType<typeof vi.fn>;
  getContextUsage: ReturnType<typeof vi.fn>;
}

function makeFakeQuery(): FakeQuery {
  const messages: unknown[] = [];
  let ended = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  let captured: Parameters<ClaudeQueryFn>[0] | undefined;
  const prompts: string[] = [];
  const uuids: Array<string | undefined> = [];
  const priorities: Array<string | undefined> = [];
  const promptWaiters: Array<{ count: number; resolve: () => void }> = [];
  const notify = (): void => {
    wake?.();
    wake = undefined;
  };
  const fake: FakeQuery = {
    prompts,
    uuids,
    priorities,
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => {
      ended = true;
      notify();
    }),
    mcpServerStatus: vi.fn(async () => []),
    getContextUsage: vi.fn(async () => ({
      totalTokens: 20_429,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      model: "claude-opus-5-5",
    })),
    queryFn: (params) => {
      captured = params;
      void (async () => {
        for await (const message of params.prompt) {
          const content = message.message.content;
          prompts.push(typeof content === "string" ? content : JSON.stringify(content));
          uuids.push(message.uuid);
          priorities.push(message.priority);
          for (const waiter of [...promptWaiters]) {
            if (prompts.length >= waiter.count) {
              promptWaiters.splice(promptWaiters.indexOf(waiter), 1);
              waiter.resolve();
            }
          }
        }
      })();
      const runtime: ClaudeQuery = {
        interrupt: fake.interrupt,
        close: fake.close,
        mcpServerStatus: fake.mcpServerStatus as never,
        getContextUsage: fake.getContextUsage as never,
        async *[Symbol.asyncIterator]() {
          while (true) {
            const next = messages.shift();
            if (next !== undefined) {
              yield next;
              continue;
            }
            if (failure) throw failure;
            if (ended) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
      };
      return runtime;
    },
    options() {
      if (!captured) throw new Error("query() was not called");
      return captured.options;
    },
    waitForPrompt(count) {
      if (prompts.length >= count) return Promise.resolve();
      return new Promise((resolve) => promptWaiters.push({ count, resolve }));
    },
    emit(message) {
      messages.push(message);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    fail(error) {
      failure = error;
      notify();
    },
  };
  return fake;
}

/** Overrides may set a default to undefined to drop it. */
type SessionOverrides = {
  [K in keyof CreateClaudeSessionOptions]?: CreateClaudeSessionOptions[K] | undefined;
};

function startSession(fake: FakeQuery, overrides: SessionOverrides = {}) {
  const merged: SessionOverrides = {
    cwd: "/tmp/proj",
    executablePath: EXECUTABLE,
    newSessionId: "11111111-1111-4111-8111-111111111111",
    queryFn: fake.queryFn,
    ...overrides,
  };
  const options = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as unknown as CreateClaudeSessionOptions;
  return createClaudeSession(options);
}

const init = (sessionId = "11111111-1111-4111-8111-111111111111") => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model: "claude-opus-5-5",
});
const assistant = (text: string) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { content: [{ type: "text", text }] },
});
const result = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  session_id: "11111111-1111-4111-8111-111111111111",
  ...extra,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createClaudeSession", () => {
  it("runs turns one after another on the same query", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const sessionIds: string[] = [];

    const first = session.runTurn({ prompt: "one", onSessionId: (id) => sessionIds.push(id) });
    await fake.waitForPrompt(1);
    fake.emit(init());
    fake.emit(assistant("first answer"));
    fake.emit(result("first answer"));
    await expect(first).resolves.toMatchObject({ text: "first answer", exitCode: 0 });

    const second = session.runTurn({ prompt: "two", onSessionId: (id) => sessionIds.push(id) });
    await fake.waitForPrompt(2);
    fake.emit(init());
    fake.emit(result("second answer"));
    await expect(second).resolves.toMatchObject({
      text: "second answer",
      exitCode: 0,
      sessionId: "11111111-1111-4111-8111-111111111111",
    });

    expect(fake.prompts).toEqual(["one", "two"]);
    // Each turn reports the session id once, so a per-turn host bridge sees it.
    expect(sessionIds).toHaveLength(2);
    expect(session.closed).toBe(false);
    expect(session.sessionId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("rejects a second turn while one is active", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const first = session.runTurn({ prompt: "one" });
    await expect(session.runTurn({ prompt: "two" })).rejects.toThrow("already has an active turn");
    fake.emit(result("done"));
    await expect(first).resolves.toMatchObject({ text: "done" });
  });

  it("reports an error result as exit code 1 with the error messages", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const turn = session.runTurn({ prompt: "one" });
    fake.emit(assistant("partial"));
    fake.emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["boom"],
      session_id: "11111111-1111-4111-8111-111111111111",
    });
    await expect(turn).resolves.toMatchObject({ text: "boom", exitCode: 1 });
    expect(session.closed).toBe(false);
  });

  it("interrupts on abort, then closes the session once the turn settles", async () => {
    // A live process would carry the stopped request into the next turn: an
    // interrupt that lands before any output leaves it unanswered, and the
    // model answers it alongside the next prompt. Resuming from disk does not.
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const reasons: string[] = [];
    session.onClose((error) => reasons.push(error.message));
    const controller = new AbortController();
    const turn = session.runTurn({ prompt: "one", signal: controller.signal });
    await fake.waitForPrompt(1);
    controller.abort();
    expect(fake.interrupt).toHaveBeenCalledTimes(1);
    // The CLI gets to finish the interrupt (and write its transcript) first.
    expect(fake.close).not.toHaveBeenCalled();
    fake.emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: [] });
    await expect(turn).rejects.toBeInstanceOf(AbortError);
    expect(session.closed).toBe(true);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(reasons).toEqual(["Claude session closed after an interrupted turn"]);
  });

  it("closes the session when an interrupted turn never settles", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake, { interruptGraceMs: 10 });
    const controller = new AbortController();
    const turn = session.runTurn({ prompt: "one", signal: controller.signal });
    controller.abort();
    await expect(turn).rejects.toBeInstanceOf(AbortError);
    expect(session.closed).toBe(true);
    expect(fake.close).toHaveBeenCalled();
  });

  it("rejects an already-aborted turn without sending it", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const controller = new AbortController();
    controller.abort();
    await expect(session.runTurn({ prompt: "one", signal: controller.signal }))
      .rejects.toBeInstanceOf(AbortError);
    expect(fake.prompts).toEqual([]);
    expect(fake.interrupt).not.toHaveBeenCalled();
  });

  it("interrupts and rejects with TimeoutError when the turn times out", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const turn = session.runTurn({ prompt: "one", timeoutMs: 10 });
    await vi.waitFor(() => expect(fake.interrupt).toHaveBeenCalled());
    fake.emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: [] });
    const error = await turn.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toContain("10ms");
    expect(session.closed).toBe(true);
  });

  it("closes the session when a background task outlives its turn", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const reasons: string[] = [];
    session.onClose((error) => reasons.push(error.message));
    const turn = session.runTurn({ prompt: "one" });
    fake.emit({ type: "system", subtype: "task_started", task_id: "bash-1", task_type: "local_bash" });
    fake.emit(result("started a server"));
    await expect(turn).resolves.toMatchObject({ text: "started a server", exitCode: 0 });
    expect(session.closed).toBe(true);
    expect(reasons).toEqual(["Claude left background tasks running at the end of a turn"]);
  });

  it("keeps the session when every task settled within the turn", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const turn = session.runTurn({ prompt: "one" });
    fake.emit({ type: "system", subtype: "task_started", task_id: "agent-1", task_type: "local_agent" });
    fake.emit({ type: "system", subtype: "task_notification", task_id: "agent-1", status: "completed" });
    fake.emit(result("done"));
    await turn;
    expect(session.closed).toBe(false);
  });

  it("answers a resumed session's prompt after an orphaned task's empty result", async () => {
    // On resume the CLI first settles a task the previous process left
    // running, with an empty result that names no prompt; the prompt's own
    // turn follows.
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const turn = session.runTurn({ prompt: "Reply PONG" });
    await fake.waitForPrompt(1);
    const uuid = fake.uuids[0];
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    fake.emit({ type: "system", subtype: "task_notification", task_id: "orphan", status: "stopped" });
    fake.emit(init());
    fake.emit(result(""));
    fake.emit(init());
    fake.emit(assistant("PONG"));
    fake.emit(result("PONG", { user_message_uuid: uuid, user_message_uuids: [uuid] }));
    await expect(turn).resolves.toMatchObject({ text: "PONG", exitCode: 0 });
    expect(session.closed).toBe(false);
  });

  it("does not settle a turn on a result that answers another prompt", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    let settled = false;
    const turn = session.runTurn({ prompt: "mine" });
    void turn.then(() => {
      settled = true;
    });
    await fake.waitForPrompt(1);
    const uuid = fake.uuids[0];
    fake.emit(assistant("someone else's answer"));
    fake.emit(result("someone else's answer", { user_message_uuid: "other", user_message_uuids: ["other"] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    fake.emit(assistant("mine"));
    fake.emit(result("mine", { user_message_uuid: uuid, user_message_uuids: [uuid] }));
    await expect(turn).resolves.toMatchObject({ text: "mine", exitCode: 0 });
  });

  it("holds the turn open until a background agent reports back", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    let settled = false;
    const turn = session.runTurn({ prompt: "research, then plan" });
    void turn.then(() => {
      settled = true;
    });
    await fake.waitForPrompt(1);
    const uuid = fake.uuids[0];
    fake.emit({ type: "system", subtype: "task_started", task_id: "agent-1", task_type: "local_agent" });
    fake.emit(assistant("launched"));
    fake.emit(result("launched", { user_message_uuid: uuid, user_message_uuids: [uuid] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(session.closed).toBe(false);

    // The CLI wakes itself for the agent's notification and answers it.
    fake.emit({ type: "system", subtype: "task_notification", task_id: "agent-1", status: "completed" });
    fake.emit(init());
    fake.emit(assistant("plan: do the thing"));
    fake.emit(result("plan: do the thing"));
    await expect(turn).resolves.toMatchObject({ text: "plan: do the thing", exitCode: 0 });
    expect(session.closed).toBe(false);
  });

  it("settles a held turn when no follow-up arrives within the grace period", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake, { followUpGraceMs: 20 });
    const turn = session.runTurn({ prompt: "research" });
    await fake.waitForPrompt(1);
    const uuid = fake.uuids[0];
    fake.emit({ type: "system", subtype: "task_started", task_id: "agent-1", task_type: "local_agent" });
    fake.emit(result("launched", { user_message_uuid: uuid }));
    fake.emit({ type: "system", subtype: "task_notification", task_id: "agent-1", status: "completed" });
    await expect(turn).resolves.toMatchObject({ text: "launched", exitCode: 0 });
    expect(session.closed).toBe(false);
  });

  it("keeps waiting on a follow-up that is still producing output", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake, { followUpGraceMs: 30 });
    const turn = session.runTurn({ prompt: "research" });
    await fake.waitForPrompt(1);
    const uuid = fake.uuids[0];
    fake.emit({ type: "system", subtype: "task_started", task_id: "agent-1", task_type: "local_agent" });
    fake.emit(result("launched", { user_message_uuid: uuid }));
    fake.emit({ type: "system", subtype: "task_notification", task_id: "agent-1", status: "completed" });
    // A long follow-up: output keeps arriving for well past the grace period.
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      fake.emit(assistant(`step ${i}`));
    }
    fake.emit(result("the plan"));
    await expect(turn).resolves.toMatchObject({ text: "the plan", exitCode: 0 });
    expect(session.closed).toBe(false);
  });

  it("stops a turn held open for a background agent at once", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const controller = new AbortController();
    const turn = session.runTurn({ prompt: "research", signal: controller.signal });
    await fake.waitForPrompt(1);
    const uuid = fake.uuids[0];
    fake.emit({ type: "system", subtype: "task_started", task_id: "agent-1", task_type: "local_agent" });
    fake.emit(result("launched", { user_message_uuid: uuid }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    // The CLI is idle between its turns, so no result will answer the
    // interrupt: the session goes without waiting out the grace period.
    await expect(turn).rejects.toBeInstanceOf(AbortError);
    expect(fake.interrupt).toHaveBeenCalledTimes(1);
    expect(session.closed).toBe(true);
  });

  it("closes the session when the CLI produces output between turns", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const turn = session.runTurn({ prompt: "one" });
    fake.emit(result("done"));
    await turn;
    // System chatter between turns is harmless.
    fake.emit({ type: "system", subtype: "session_state_changed" });
    fake.emit(assistant("I woke myself up"));
    await vi.waitFor(() => expect(session.closed).toBe(true));
    await expect(session.runTurn({ prompt: "two" }))
      .rejects.toThrow("Claude produced output outside a turn");
  });

  it("rejects later turns with the reason the CLI died", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    fake.fail(new Error("Claude Code process exited with code 1: invalid model"));
    await vi.waitFor(() => expect(session.closed).toBe(true));
    await expect(session.runTurn({ prompt: "one" })).rejects.toThrow("invalid model");
  });

  it("rejects the active turn when the CLI exits mid-turn", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const turn = session.runTurn({ prompt: "one" });
    fake.end();
    await expect(turn).rejects.toThrow("Claude process exited");
    expect(session.closed).toBe(true);
  });

  it("rejects the active turn with the stream's own error", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const turn = session.runTurn({ prompt: "one" });
    fake.fail(new Error("Claude Code process exited with code 1"));
    await expect(turn).rejects.toThrow("Claude Code process exited with code 1");
  });

  it("calls onClose once, and immediately for a late subscriber", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const early = vi.fn();
    session.onClose(early);
    await session.close();
    await session.close();
    expect(early).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    session.onClose(late);
    expect(late).toHaveBeenCalledWith(expect.objectContaining({ message: "Claude session closed" }));
  });
});

describe("ClaudeSession context window", () => {
  const reply = (model: string, text = "ok") => ({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      model,
      content: [{ type: "text", text }],
      usage: { input_tokens: 5, cache_read_input_tokens: 300_000, output_tokens: 3 },
    },
  });

  /** Runs one turn that a single reply and result answer. */
  async function turn(
    fake: FakeQuery,
    session: Awaited<ReturnType<typeof startSession>>,
    count: number,
    lines: unknown[],
  ) {
    const onUsage = vi.fn();
    const running = session.runTurn({ prompt: `turn ${count}`, onUsage });
    await fake.waitForPrompt(count);
    for (const line of lines) fake.emit(line);
    return { result: await running, onUsage };
  }

  it("keeps the init line's [1m] marker for turns after the first", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    await turn(fake, session, 1, [
      { ...init(), model: "claude-sonnet-4-6[1m]" },
      reply("claude-sonnet-4-6"),
      result("ok"),
    ]);
    const second = await turn(fake, session, 2, [reply("claude-sonnet-4-6"), result("ok")]);
    expect(second.onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6[1m]", contextWindow: 1_000_000 }),
    );
  });

  it("uses the window an earlier result reported while a later turn runs", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    await turn(fake, session, 1, [
      init(),
      reply("claude-opus-5-5"),
      result("ok", { modelUsage: { "claude-opus-5-5": { contextWindow: 500_000 } } }),
    ]);
    const second = await turn(fake, session, 2, [
      reply("claude-opus-5-5"),
      result("ok", { modelUsage: { "claude-opus-5-5": { contextWindow: "huge" } } }),
    ]);
    expect(second.onUsage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: "claude-opus-5-5", contextWindow: 500_000 }),
    );
    expect(second.result.usage).toMatchObject({ model: "claude-opus-5-5", contextWindow: 500_000 });
  });

  it("keeps each session's reported windows to itself", async () => {
    const fakeA = makeFakeQuery();
    const fakeB = makeFakeQuery();
    const a = await startSession(fakeA);
    const b = await startSession(fakeB, { newSessionId: "22222222-2222-4222-8222-222222222222" });
    const learn = (contextWindow: number) => [
      init(),
      reply("claude-opus-5-5"),
      result("ok", { modelUsage: { "claude-opus-5-5": { contextWindow } } }),
    ];
    await turn(fakeA, a, 1, learn(500_000));
    await turn(fakeB, b, 1, learn(300_000));
    const secondA = await turn(fakeA, a, 2, [reply("claude-opus-5-5"), result("ok")]);
    const secondB = await turn(fakeB, b, 2, [reply("claude-opus-5-5"), result("ok")]);
    expect(secondA.onUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({ contextWindow: 500_000 }));
    expect(secondB.onUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({ contextWindow: 300_000 }));
  });

  it("learns nothing from a result that answers another prompt", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const onUsage = vi.fn();
    const first = session.runTurn({ prompt: "turn 1", onUsage });
    await fake.waitForPrompt(1);
    const uuid = fake.uuids[0];
    fake.emit(init());
    fake.emit(result("other", {
      user_message_uuid: "other",
      user_message_uuids: ["other"],
      modelUsage: { "claude-opus-5-5": { contextWindow: 500_000 } },
    }));
    fake.emit(reply("claude-opus-5-5"));
    fake.emit(result("ok", { user_message_uuid: uuid, user_message_uuids: [uuid] }));
    await first;
    const onSecondUsage = vi.fn();
    const second = session.runTurn({ prompt: "turn 2", onUsage: onSecondUsage });
    await fake.waitForPrompt(2);
    const secondUuid = fake.uuids[1];
    fake.emit(reply("claude-opus-5-5"));
    fake.emit(result("ok", { user_message_uuid: secondUuid, user_message_uuids: [secondUuid] }));
    await second;
    expect(onSecondUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({ contextWindow: 1_000_000 }));
  });
});

describe("ClaudeSession.steer", () => {
  it("sends the steer into the running turn, to be read at the next tool round", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const turn = session.runTurn({ prompt: "do the thing" });
    await fake.waitForPrompt(1);
    await session.steer({ prompt: "also do this" });
    await fake.waitForPrompt(2);
    expect(fake.prompts).toEqual(["do the thing", "also do this"]);
    expect(fake.priorities).toEqual([undefined, "next"]);
    expect(fake.uuids[1]).toEqual(expect.any(String));
    expect(fake.uuids[1]).not.toBe(fake.uuids[0]);
    fake.emit(result("done", { user_message_uuids: [fake.uuids[0], fake.uuids[1]] }));
    await expect(turn).resolves.toMatchObject({ text: "done", exitCode: 0 });
  });

  it("holds the turn for a steer the CLI runs as its own turn", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    let settled = false;
    const turn = session.runTurn({ prompt: "do the thing" });
    void turn.then(() => {
      settled = true;
    });
    await fake.waitForPrompt(1);
    await session.steer({ prompt: "also do this" });
    await fake.waitForPrompt(2);
    const [promptUuid, steerUuid] = fake.uuids;
    fake.emit(assistant("first answer"));
    fake.emit(result("first answer", { user_message_uuids: [promptUuid] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    // The steer's own reply arrives while the turn is still open, so it is
    // not mistaken for output between turns.
    fake.emit(assistant("steered answer"));
    fake.emit(result("steered answer", { user_message_uuids: [steerUuid] }));
    await expect(turn).resolves.toMatchObject({ text: "steered answer", exitCode: 0 });
    expect(session.closed).toBe(false);
  });

  it("settles on one result that names only the steer, the last of the batch", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const turn = session.runTurn({ prompt: "do the thing" });
    await fake.waitForPrompt(1);
    await session.steer({ prompt: "also do this" });
    await fake.waitForPrompt(2);
    fake.emit(result("both done", { user_message_uuid: fake.uuids[1] }));
    await expect(turn).resolves.toMatchObject({ text: "both done" });
  });

  it("rejects a steer with no turn running", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    await expect(session.steer({ prompt: "hello" })).rejects.toBeInstanceOf(SteerRejectedError);
  });

  it("rejects a steer once the turn's result has arrived", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const turn = session.runTurn({ prompt: "research" });
    await fake.waitForPrompt(1);
    // A live subagent holds the turn open past its result.
    fake.emit({ type: "system", subtype: "task_started", task_id: "agent-1", task_type: "local_agent" });
    fake.emit(result("launched", { user_message_uuids: [fake.uuids[0]] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(session.steer({ prompt: "too late" })).rejects.toBeInstanceOf(SteerRejectedError);
    expect(fake.prompts).toEqual(["research"]);
    fake.emit({ type: "system", subtype: "task_notification", task_id: "agent-1", status: "completed" });
    fake.emit(result("all done"));
    await expect(turn).resolves.toMatchObject({ text: "all done" });
  });

  it("rejects a steer while the turn is being interrupted", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const controller = new AbortController();
    const turn = session.runTurn({ prompt: "one", signal: controller.signal });
    await fake.waitForPrompt(1);
    controller.abort();
    await expect(session.steer({ prompt: "two" })).rejects.toBeInstanceOf(SteerRejectedError);
    fake.emit(result("stopped", { subtype: "error_during_execution", is_error: true }));
    await expect(turn).rejects.toBeInstanceOf(AbortError);
  });

  it("rejects a steer after the session closed", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    await session.close();
    await expect(session.steer({ prompt: "hello" })).rejects.toBeInstanceOf(SteerRejectedError);
  });
});

describe("createClaudeSession options", () => {
  it("maps a regular session onto Agent SDK options", async () => {
    const fake = makeFakeQuery();
    const hooks = { PreToolUse: [{ matcher: "*", hooks: [async () => ({})] }] };
    vi.stubEnv("CLAUDECODE", "1");
    vi.stubEnv("KEEP_ME", "yes");
    await startSession(fake, {
      model: "opus",
      effort: "high",
      permissionMode: "plan",
      tools: ["default"],
      allowedTools: ["Glob", "Grep"],
      disallowedTools: ["ExitPlanMode"],
      settingSources: ["user", "project", "local"],
      settings: { disableAllHooks: false },
      appendSystemPrompt: "Be brief.",
      hooks,
    });
    vi.unstubAllEnvs();
    const options = fake.options();
    expect(options).toMatchObject({
      cwd: "/tmp/proj",
      pathToClaudeCodeExecutable: EXECUTABLE,
      sessionId: "11111111-1111-4111-8111-111111111111",
      systemPrompt: { type: "preset", preset: "claude_code", append: "Be brief." },
      includePartialMessages: true,
      model: "opus",
      effort: "high",
      permissionMode: "plan",
      tools: { type: "preset", preset: "claude_code" },
      allowedTools: ["Glob", "Grep"],
      disallowedTools: ["ExitPlanMode"],
      settingSources: ["user", "project", "local"],
      settings: { disableAllHooks: false },
      hooks,
    });
    expect(options.resume).toBeUndefined();
    expect(options.persistSession).toBeUndefined();
    expect(options.env?.CLAUDECODE).toBeUndefined();
    expect(options.env?.KEEP_ME).toBe("yes");
    expect(typeof options.spawnClaudeCodeProcess).toBe("function");
  });

  it("resumes by id and maps manual to the CLI's default mode", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake, {
      newSessionId: undefined,
      resumeSessionId: "22222222-2222-4222-8222-222222222222",
      permissionMode: "manual",
    });
    expect(session.sessionId).toBe("22222222-2222-4222-8222-222222222222");
    expect(fake.options()).toMatchObject({
      resume: "22222222-2222-4222-8222-222222222222",
      permissionMode: "default",
    });
    expect(fake.options().sessionId).toBeUndefined();
  });

  it("allows bypassPermissions only with the SDK's explicit opt-in", async () => {
    const fake = makeFakeQuery();
    await startSession(fake, { permissionMode: "bypassPermissions" });
    expect(fake.options()).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
  });

  it("keeps an explicit empty tool list empty", async () => {
    const fake = makeFakeQuery();
    await startSession(fake, { tools: [] });
    expect(fake.options().tools).toEqual([]);
  });

  it("runs isolated sessions without tools, MCP, persistence, or customizations", async () => {
    const fake = makeFakeQuery();
    await startSession(fake, { newSessionId: undefined, isolated: true, model: "haiku" });
    expect(fake.options()).toMatchObject({
      tools: [],
      strictMcpConfig: true,
      persistSession: false,
      extraArgs: { "safe-mode": null },
      model: "haiku",
      systemPrompt: { type: "preset", preset: "claude_code" },
    });
    expect(fake.options().sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("forks a session as an isolated, non-persistent side run", async () => {
    const fake = makeFakeQuery();
    await startSession(fake, {
      newSessionId: undefined,
      isolated: true,
      forkSessionId: "22222222-2222-4222-8222-222222222222",
    });
    expect(fake.options()).toMatchObject({
      resume: "22222222-2222-4222-8222-222222222222",
      forkSession: true,
      tools: [],
      strictMcpConfig: true,
      persistSession: false,
      extraArgs: { "safe-mode": null },
    });
    // The fork gets an id of its own, never the parent's.
    expect(fake.options().sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.options().sessionId).not.toBe("22222222-2222-4222-8222-222222222222");
  });

  it("denies every tool a forked run reaches for", async () => {
    const fake = makeFakeQuery();
    await startSession(fake, {
      newSessionId: undefined,
      isolated: true,
      forkSessionId: "22222222-2222-4222-8222-222222222222",
    });
    const [matcher] = fake.options().hooks?.PreToolUse ?? [];
    expect(matcher?.matcher).toBe("*");
    const decision = await matcher!.hooks[0]!(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } as never,
      "tool-1",
      { signal: new AbortController().signal },
    );
    expect(decision).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
  });

  it("forks a guarded session with the caller's tools, permissions and guard, saving nothing", async () => {
    const fake = makeFakeQuery();
    const guard = { matcher: "*", hooks: [async () => ({})] };
    await startSession(fake, {
      newSessionId: undefined,
      forkSessionId: "22222222-2222-4222-8222-222222222222",
      tools: ["default"],
      allowedTools: ["Glob", "Grep"],
      permissionMode: "auto",
      settingSources: ["user", "project", "local"],
      settings: { disableAllHooks: false },
      hooks: { PreToolUse: [guard] },
    });
    expect(fake.options()).toMatchObject({
      resume: "22222222-2222-4222-8222-222222222222",
      forkSession: true,
      persistSession: false,
      tools: { type: "preset", preset: "claude_code" },
      allowedTools: ["Glob", "Grep"],
      permissionMode: "auto",
      settingSources: ["user", "project", "local"],
      settings: { disableAllHooks: false },
    });
    // The caller's guard alone decides: nothing is put in front of it.
    expect(fake.options().hooks?.PreToolUse).toEqual([guard]);
    expect(fake.options().sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("passes MCP servers through to the SDK", async () => {
    const fake = makeFakeQuery();
    const mcpServers = { "agent-remote": { type: "http" as const, url: "http://127.0.0.1:1/mcp" } };
    await startSession(fake, { mcpServers });
    expect(fake.options().mcpServers).toEqual(mcpServers);
  });

  it("leaves MCP servers out when none are given", async () => {
    const fake = makeFakeQuery();
    await startSession(fake);
    expect(fake.options()).not.toHaveProperty("mcpServers");
  });

  it.each([
    [{ newSessionId: "a", resumeSessionId: "b" }, "mutually exclusive"],
    [
      { isolated: true, mcpServers: { x: { type: "http" as const, url: "http://127.0.0.1:1" } } },
      "cannot set MCP servers",
    ],
    [{ newSessionId: undefined, isolated: true, resumeSessionId: "b" }, "cannot resume"],
    [{ isolated: true, permissionMode: "plan" as const }, "cannot set a permission mode"],
    [{ isolated: true, tools: ["Read"] }, "cannot set tools"],
    [{ isolated: true, forkSessionId: "p" }, "mutually exclusive"],
    [{ newSessionId: undefined, isolated: true, forkSessionId: "p", resumeSessionId: "b" }, "mutually exclusive"],
  ])("rejects invalid option combinations %#", async (overrides, message) => {
    const fake = makeFakeQuery();
    await expect(startSession(fake, overrides)).rejects.toThrow(message);
  });

  it("rejects with MissingCliError when the executable is not on PATH", async () => {
    const fake = makeFakeQuery();
    await expect(startSession(fake, {
      executablePath: "claude-does-not-exist",
      env: { PATH: "/nonexistent" },
    })).rejects.toBeInstanceOf(MissingCliError);
    await expect(startSession(fake, { executablePath: "/nonexistent/claude" }))
      .rejects.toBeInstanceOf(MissingCliError);
  });

  it("resolves a bare executable name to an absolute path through PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-path-"));
    // Windows finds a CLI by its extension; elsewhere by its execute bit.
    const bin = join(dir, process.platform === "win32" ? "claude.cmd" : "claude");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    const fake = makeFakeQuery();
    await startSession(fake, {
      executablePath: undefined,
      env: { PATH: [join(dir, "missing"), dir].join(delimiter) },
    });
    expect(fake.options().pathToClaudeCodeExecutable).toBe(bin);
  });
});

describe("createClaudeSession process", () => {
  interface FakeChild extends EventEmitter {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  }

  function makeFakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return true;
    });
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    return child;
  }

  it("spawns the CLI as a process-group leader and kills its tree on close", async () => {
    const fake = makeFakeQuery();
    const child = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    const session = await startSession(fake, { spawnFn: spawnFn as never });
    const controller = new AbortController();
    const spawned = fake.options().spawnClaudeCodeProcess!({
      command: EXECUTABLE,
      args: ["--output-format", "stream-json"],
      cwd: "/tmp/proj",
      env: { PATH: "/usr/bin" },
      signal: controller.signal,
    });
    const [command, args, spawnOptions] = spawnFn.mock.calls[0]!;
    expect(command).toBe(EXECUTABLE);
    expect(args).toEqual(["--output-format", "stream-json"]);
    expect(spawnOptions).toMatchObject({
      cwd: "/tmp/proj",
      env: { PATH: "/usr/bin" },
      detached: process.platform !== "win32",
    });
    expect(spawned.stdin).toBe(child.stdin);
    expect(spawned.stdout).toBe(child.stdout);
    // No pid on the fake, so the group kill falls back to the child itself.
    spawned.kill("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await session.close();
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it("routes stderr to the active turn", async () => {
    const fake = makeFakeQuery();
    const child = makeFakeChild();
    const session = await startSession(fake, { spawnFn: vi.fn().mockReturnValue(child) as never });
    fake.options().spawnClaudeCodeProcess!({
      command: EXECUTABLE,
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    const stderr: string[] = [];
    const turn = session.runTurn({ prompt: "one", onStderr: (chunk) => stderr.push(chunk) });
    child.stderr.write("warning: something\n");
    await vi.waitFor(() => expect(stderr).toEqual(["warning: something\n"]));
    fake.emit(result("done"));
    await turn;
  });

  it("includes the stderr tail when the CLI exits mid-turn", async () => {
    const fake = makeFakeQuery();
    const child = makeFakeChild();
    const session = await startSession(fake, { spawnFn: vi.fn().mockReturnValue(child) as never });
    fake.options().spawnClaudeCodeProcess!({
      command: EXECUTABLE,
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    const turn = session.runTurn({ prompt: "one" });
    child.stderr.write("Error: invalid model\n");
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.end();
    await expect(turn).rejects.toThrow("Claude process exited: Error: invalid model");
  });
});

describe("runClaude", () => {
  it("runs one turn in a fresh session and closes it", async () => {
    const fake = makeFakeQuery();
    const texts: string[] = [];
    const run = runClaude({
      prompt: "make it round",
      cwd: "/tmp/proj",
      executablePath: EXECUTABLE,
      newSessionId: "11111111-1111-4111-8111-111111111111",
      queryFn: fake.queryFn,
      onAssistantText: (text) => texts.push(text),
    });
    await fake.waitForPrompt(1);
    fake.emit(init());
    fake.emit(assistant("Done."));
    fake.emit(result("Done."));
    await expect(run).resolves.toEqual({
      text: "Done.",
      exitCode: 0,
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
    expect(fake.prompts).toEqual(["make it round"]);
    expect(texts).toEqual(["Done."]);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("passes allowedTools and hooks through to the session", async () => {
    const fake = makeFakeQuery();
    const hooks = { PreToolUse: [{ hooks: [async () => ({})] }] };
    const run = runClaude({
      prompt: "x",
      cwd: "/tmp/proj",
      executablePath: EXECUTABLE,
      queryFn: fake.queryFn,
      tools: ["default"],
      allowedTools: ["Glob"],
      hooks,
    });
    fake.emit(result("ok"));
    await run;
    expect(fake.options()).toMatchObject({ allowedTools: ["Glob"], hooks });
  });

  it("never starts a session for an already-aborted signal", async () => {
    const queryFn = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(runClaude({
      prompt: "x",
      cwd: "/tmp/proj",
      executablePath: EXECUTABLE,
      queryFn: queryFn as never,
      signal: controller.signal,
    })).rejects.toBeInstanceOf(AbortError);
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("closes the session after an aborted turn", async () => {
    const fake = makeFakeQuery();
    const controller = new AbortController();
    const run = runClaude({
      prompt: "x",
      cwd: "/tmp/proj",
      executablePath: EXECUTABLE,
      queryFn: fake.queryFn,
      signal: controller.signal,
    });
    await fake.waitForPrompt(1);
    controller.abort();
    fake.emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: [] });
    await expect(run).rejects.toBeInstanceOf(AbortError);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});

describe("createClaudeSession MCP status", () => {
  const initWith = (servers: Array<{ name: string; status: string }>) => ({
    ...init(),
    mcp_servers: servers,
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the init line's servers, with pending as connecting", async () => {
    const fake = makeFakeQuery();
    fake.mcpServerStatus.mockImplementation(async () => {
      throw new Error("status unavailable");
    });
    const session = await startSession(fake);
    const snapshots: unknown[] = [];
    const turn = session.runTurn({
      prompt: "x",
      onMcpStatus: (servers) => snapshots.push(servers),
    });
    await fake.waitForPrompt(1);
    fake.emit(initWith([
      { name: "a", status: "connected" },
      { name: "b", status: "pending" },
      { name: "c", status: "needs-auth" },
      { name: "d", status: "disabled" },
      { name: "e", status: "failed" },
      { name: "f", status: "something-new" },
    ]));
    fake.emit(result("done"));
    await expect(turn).resolves.toMatchObject({ exitCode: 0 });
    expect(snapshots[0]).toEqual([
      { name: "a", status: "connected" },
      { name: "b", status: "connecting" },
      { name: "c", status: "needs-auth" },
      { name: "d", status: "disabled" },
      { name: "e", status: "failed" },
    ]);
    await session.close();
  });

  it("gets error details from mcpServerStatus and keeps them when init repeats", async () => {
    const fake = makeFakeQuery();
    fake.mcpServerStatus.mockResolvedValue([
      { name: "bad", status: "failed", error: "Connection closed" },
    ]);
    const session = await startSession(fake);
    const snapshots: unknown[] = [];
    const onMcpStatus = (servers: unknown) => snapshots.push(servers);
    const first = session.runTurn({ prompt: "x", onMcpStatus });
    await fake.waitForPrompt(1);
    fake.emit(initWith([{ name: "bad", status: "failed" }]));
    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toEqual([{ name: "bad", status: "failed", error: "Connection closed" }]);
    });
    fake.emit(result("done"));
    await first;

    snapshots.length = 0;
    const second = session.runTurn({ prompt: "y", onMcpStatus });
    await fake.waitForPrompt(2);
    fake.emit(initWith([{ name: "bad", status: "failed" }]));
    fake.emit(result("done"));
    await second;
    expect(snapshots[0]).toEqual([{ name: "bad", status: "failed", error: "Connection closed" }]);
    expect(snapshots.every((snapshot) => JSON.stringify(snapshot).includes("Connection closed"))).toBe(true);
    await session.close();
  });

  it("sends the cached snapshot at the start of a later turn even with no new init", async () => {
    const fake = makeFakeQuery();
    fake.mcpServerStatus.mockResolvedValue([{ name: "a", status: "connected" }]);
    const session = await startSession(fake);
    const first = session.runTurn({ prompt: "x", onMcpStatus: () => {} });
    await fake.waitForPrompt(1);
    fake.emit(initWith([{ name: "a", status: "connected" }]));
    fake.emit(result("done"));
    await first;

    const snapshots: unknown[] = [];
    const second = session.runTurn({ prompt: "y", onMcpStatus: (servers) => snapshots.push(servers) });
    await fake.waitForPrompt(2);
    expect(snapshots[0]).toEqual([{ name: "a", status: "connected" }]);
    fake.emit(result("done"));
    await second;
    await session.close();
  });

  it("re-polls while a server is connecting, then stops once it settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fake = makeFakeQuery();
    fake.mcpServerStatus
      .mockResolvedValueOnce([{ name: "slow", status: "pending" }])
      .mockResolvedValueOnce([{ name: "slow", status: "connected" }]);
    const session = await startSession(fake);
    const snapshots: unknown[] = [];
    const turn = session.runTurn({ prompt: "x", onMcpStatus: (servers) => snapshots.push(servers) });
    await fake.waitForPrompt(1);
    fake.emit(initWith([{ name: "slow", status: "pending" }]));
    await vi.waitFor(() => expect(fake.mcpServerStatus).toHaveBeenCalledTimes(1));
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toEqual([{ name: "slow", status: "connected" }]);
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.mcpServerStatus).toHaveBeenCalledTimes(2);
    fake.emit(result("done"));
    await turn;
    await session.close();
  });

  it("gives up polling after 30 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fake = makeFakeQuery();
    fake.mcpServerStatus.mockResolvedValue([{ name: "slow", status: "pending" }]);
    const session = await startSession(fake);
    const turn = session.runTurn({ prompt: "x", onMcpStatus: () => {} });
    await fake.waitForPrompt(1);
    fake.emit(initWith([{ name: "slow", status: "pending" }]));
    await vi.waitFor(() => expect(fake.mcpServerStatus).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(60_000);
    const calls = fake.mcpServerStatus.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(17);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.mcpServerStatus.mock.calls.length).toBe(calls);
    fake.emit(result("done"));
    await turn;
    await session.close();
  });

  it("asks again for the new turn when a status call outlives the turn that made it", async () => {
    const fake = makeFakeQuery();
    let finishFirst: (servers: unknown) => void = () => {};
    fake.mcpServerStatus
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishFirst = resolve;
      }))
      .mockResolvedValue([{ name: "slow", status: "connected" }]);
    const session = await startSession(fake);
    const first = session.runTurn({ prompt: "x", onMcpStatus: () => {} });
    await fake.waitForPrompt(1);
    fake.emit(initWith([{ name: "slow", status: "pending" }]));
    await vi.waitFor(() => expect(fake.mcpServerStatus).toHaveBeenCalledTimes(1));
    fake.emit(result("done"));
    await first;

    const snapshots: unknown[] = [];
    const second = session.runTurn({ prompt: "y", onMcpStatus: (servers) => snapshots.push(servers) });
    await fake.waitForPrompt(2);
    finishFirst([{ name: "slow", status: "pending" }]);
    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toEqual([{ name: "slow", status: "connected" }]);
    });
    fake.emit(result("done"));
    await second;
    await session.close();
  });

  it("keeps the last snapshot when a status call fails, and the turn is unaffected", async () => {
    const fake = makeFakeQuery();
    fake.mcpServerStatus.mockRejectedValue(new Error("nope"));
    const session = await startSession(fake);
    const snapshots: unknown[] = [];
    const turn = session.runTurn({ prompt: "x", onMcpStatus: (servers) => snapshots.push(servers) });
    await fake.waitForPrompt(1);
    fake.emit(initWith([{ name: "a", status: "connected" }]));
    await vi.waitFor(() => expect(fake.mcpServerStatus).toHaveBeenCalled());
    await flush();
    fake.emit(result("done"));
    await expect(turn).resolves.toMatchObject({ exitCode: 0 });
    expect(snapshots).toEqual([[{ name: "a", status: "connected" }]]);
    await session.close();
  });

  it("never asks for status when the turn has no status callback", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const turn = session.runTurn({ prompt: "x" });
    await fake.waitForPrompt(1);
    fake.emit(initWith([{ name: "a", status: "pending" }]));
    fake.emit(result("done"));
    await turn;
    expect(fake.mcpServerStatus).not.toHaveBeenCalled();
    await session.close();
  });
});

describe("createClaudeSession MCP elicitation", () => {
  const form = {
    serverName: "probe",
    message: "Who are you?",
    mode: "form" as const,
    requestedSchema: { type: "object", properties: { name: { type: "string" } } },
  };
  const elicit = (
    fake: FakeQuery,
    request: Record<string, unknown>,
    signal = new AbortController().signal,
  ) => {
    const onElicitation = fake.options().onElicitation;
    if (!onElicitation) throw new Error("no onElicitation");
    return onElicitation(request as never, { signal, requestId: "r1" });
  };

  it("hands a form to the running turn and returns its answer", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const onMcpElicitation = vi.fn(async () => ({
      action: "accept" as const,
      content: { name: "Ada" },
    }));
    const turn = session.runTurn({ prompt: "x", onMcpElicitation });
    await fake.waitForPrompt(1);
    await expect(elicit(fake, form)).resolves.toEqual({ action: "accept", content: { name: "Ada" } });
    expect(onMcpElicitation).toHaveBeenCalledWith(
      { serverName: "probe", message: "Who are you?", mode: "form", requestedSchema: form.requestedSchema },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    fake.emit(result("done"));
    await turn;
    await session.close();
  });

  it("treats a missing mode as a form", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const onMcpElicitation = vi.fn(async () => ({ action: "decline" as const }));
    const turn = session.runTurn({ prompt: "x", onMcpElicitation });
    await fake.waitForPrompt(1);
    await elicit(fake, { serverName: "probe", message: "Sure?" });
    expect(onMcpElicitation).toHaveBeenCalledWith(
      { serverName: "probe", message: "Sure?", mode: "form", requestedSchema: { type: "object", properties: {} } },
      expect.anything(),
    );
    fake.emit(result("done"));
    await turn;
    await session.close();
  });

  it("hands over a URL request, and declines one with no URL", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const onMcpElicitation = vi.fn(async () => ({ action: "accept" as const }));
    const turn = session.runTurn({ prompt: "x", onMcpElicitation });
    await fake.waitForPrompt(1);
    await expect(elicit(fake, { serverName: "probe", message: "Go", mode: "url" }))
      .resolves.toEqual({ action: "decline" });
    expect(onMcpElicitation).not.toHaveBeenCalled();
    await expect(elicit(fake, {
      serverName: "probe",
      message: "Go",
      mode: "url",
      url: "https://example.com/signin",
    })).resolves.toEqual({ action: "accept" });
    expect(onMcpElicitation).toHaveBeenCalledWith(
      { serverName: "probe", message: "Go", mode: "url", url: "https://example.com/signin" },
      expect.anything(),
    );
    fake.emit(result("done"));
    await turn;
    await session.close();
  });

  it("declines with no running turn or no callback", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    await expect(elicit(fake, form)).resolves.toEqual({ action: "decline" });
    const turn = session.runTurn({ prompt: "x" });
    await fake.waitForPrompt(1);
    await expect(elicit(fake, form)).resolves.toEqual({ action: "decline" });
    fake.emit(result("done"));
    await turn;
    await session.close();
  });

  it("cancels when the callback throws", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const turn = session.runTurn({
      prompt: "x",
      onMcpElicitation: async () => {
        throw new Error("boom");
      },
    });
    await fake.waitForPrompt(1);
    await expect(elicit(fake, form)).resolves.toEqual({ action: "cancel" });
    fake.emit(result("done"));
    await turn;
    await session.close();
  });

  it("cancels and aborts when the SDK's signal fires", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    let seen: AbortSignal | undefined;
    const turn = session.runTurn({
      prompt: "x",
      onMcpElicitation: (_request, { signal }) => {
        seen = signal;
        return new Promise(() => {});
      },
    });
    await fake.waitForPrompt(1);
    const sdk = new AbortController();
    const answer = elicit(fake, form, sdk.signal);
    sdk.abort();
    await expect(answer).resolves.toEqual({ action: "cancel" });
    expect(seen?.aborted).toBe(true);
    fake.emit(result("done"));
    await turn;
    await session.close();
  });

  it("cancels and aborts an open request when the turn settles", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    let seen: AbortSignal | undefined;
    const turn = session.runTurn({
      prompt: "x",
      onMcpElicitation: (_request, { signal }) => {
        seen = signal;
        return new Promise(() => {});
      },
    });
    await fake.waitForPrompt(1);
    const answer = elicit(fake, form);
    fake.emit(result("done"));
    await turn;
    await expect(answer).resolves.toEqual({ action: "cancel" });
    expect(seen?.aborted).toBe(true);
    await session.close();
  });

  it("cancels an open request when the session closes", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const turn = session.runTurn({
      prompt: "x",
      onMcpElicitation: () => new Promise(() => {}),
    });
    await fake.waitForPrompt(1);
    const answer = elicit(fake, form);
    fake.fail(new Error("cli died"));
    await expect(turn).rejects.toThrow();
    await expect(answer).resolves.toEqual({ action: "cancel" });
  });

  it("gives isolated sessions no elicitation path", async () => {
    const fake = makeFakeQuery();
    await startSession(fake, { isolated: true });
    expect(fake.options().onElicitation).toBeUndefined();
  });
});

describe("ClaudeSession.compact", () => {
  const boundary = {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "manual", pre_tokens: 18_078, post_tokens: 4_180 },
  };

  it("sends Claude Code's own /compact and reports what is left afterwards", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const onCompaction = vi.fn();
    const onUsage = vi.fn();
    const turn = session.compact({ onCompaction, onUsage });
    await fake.waitForPrompt(1);
    expect(fake.prompts).toEqual(["/compact"]);
    fake.emit(init());
    fake.emit(boundary);
    fake.emit(result("", { user_message_uuid: fake.uuids[0] }));
    const outcome = await turn;
    expect(outcome).toMatchObject({ text: "", exitCode: 0 });
    expect(onCompaction).toHaveBeenCalledWith({ trigger: "manual", preTokens: 18_078, postTokens: 4_180 });
    expect(fake.getContextUsage).toHaveBeenCalledWith({ detail: "full" });
    const measured = {
      contextTokens: 20_429,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      model: "claude-opus-5-5",
      contextWindow: 1_000_000,
    };
    expect(onUsage).toHaveBeenLastCalledWith(measured);
    expect(outcome.usage).toEqual(measured);
    expect(session.closed).toBe(false);
  });

  it("passes focus instructions after the command", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const turn = session.compact({ instructions: "  keep the API decisions  " });
    await fake.waitForPrompt(1);
    expect(fake.prompts).toEqual(["/compact keep the API decisions"]);
    fake.emit(boundary);
    fake.emit(result(""));
    await expect(turn).resolves.toMatchObject({ exitCode: 0 });
  });

  it("settles without a size when the CLI cannot measure one", async () => {
    const fake = makeFakeQuery();
    fake.getContextUsage.mockRejectedValue(new Error("unsupported"));
    const session = await startSession(fake);
    const onUsage = vi.fn();
    const turn = session.compact({ onUsage });
    await fake.waitForPrompt(1);
    fake.emit(boundary);
    fake.emit(result(""));
    const outcome = await turn;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.usage).toBeUndefined();
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("does not measure a compaction that failed", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const turn = session.compact({});
    await fake.waitForPrompt(1);
    fake.emit({ ...result(""), is_error: true, subtype: "error_during_execution", errors: ["Not enough messages to compact."] });
    await expect(turn).resolves.toMatchObject({ exitCode: 1, text: "Not enough messages to compact." });
    expect(fake.getContextUsage).not.toHaveBeenCalled();
  });

  /** A compaction whose result is in while the CLI is still counting. */
  async function measuring(signal?: AbortSignal) {
    const fake = makeFakeQuery();
    let count!: (value: unknown) => void;
    fake.getContextUsage.mockImplementation(() => new Promise((resolve) => {
      count = resolve;
    }));
    const session = await startSession(fake);
    const turn = session.compact(signal ? { signal } : {});
    const outcome = turn.then(
      (result) => ({ result }),
      (error: Error) => ({ error }),
    );
    await fake.waitForPrompt(1);
    fake.emit(boundary);
    fake.emit(result(""));
    await vi.waitFor(() => expect(fake.getContextUsage).toHaveBeenCalled());
    return { fake, session, outcome, count: (total: number) => count({ totalTokens: total }) };
  }

  it("stays the active turn while it measures what is left", async () => {
    const { session, outcome, count } = await measuring();
    await expect(session.runTurn({ prompt: "next" })).rejects.toThrow(/active turn/);
    count(20_000);
    await expect(outcome).resolves.toMatchObject({ result: { exitCode: 0, usage: { contextTokens: 20_000 } } });
    expect(session.closed).toBe(false);
  });

  it("stops while it measures, keeping the session", async () => {
    const controller = new AbortController();
    const { session, outcome, count } = await measuring(controller.signal);
    controller.abort();
    await expect(outcome).resolves.toMatchObject({ error: { name: "AbortError" } });
    count(20_000);
    expect(session.closed).toBe(false);
    const next = session.runTurn({ prompt: "next" });
    await expect(Promise.race([next.then(() => "settled", () => "settled"), Promise.resolve("running")]))
      .resolves.toBe("running");
  });

  it("ends with the session if it closes while measuring", async () => {
    const { session, outcome } = await measuring();
    await session.close();
    await expect(outcome).resolves.toMatchObject({ error: expect.any(Error) });
  });

  it("cannot be steered", async () => {
    const fake = makeFakeQuery();
    const session = await startSession(fake);
    const turn = session.compact({});
    await fake.waitForPrompt(1);
    await expect(session.steer({ prompt: "and also" })).rejects.toBeInstanceOf(SteerRejectedError);
    fake.emit(boundary);
    fake.emit(result(""));
    await turn;
  });
});
