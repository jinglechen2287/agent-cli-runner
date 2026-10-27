import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it.each([
    [{ newSessionId: "a", resumeSessionId: "b" }, "mutually exclusive"],
    [{ newSessionId: undefined, isolated: true, resumeSessionId: "b" }, "cannot resume"],
    [{ isolated: true, permissionMode: "plan" as const }, "cannot set a permission mode"],
    [{ isolated: true, tools: ["Read"] }, "cannot set tools"],
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
    const bin = join(dir, "claude");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    const fake = makeFakeQuery();
    await startSession(fake, { executablePath: undefined, env: { PATH: `/nonexistent:${dir}` } });
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
