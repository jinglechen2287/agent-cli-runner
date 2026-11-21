import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AbortError,
  AgyAuthError,
  AgyTurnError,
  createAgySession,
  ProviderTurnError,
  SteerRejectedError,
  TimeoutError,
  type AgyPermissionRequest,
  type BackgroundAgentInfo,
  type CreateAgySessionOptions,
} from "../src/index.js";
import type { AgyStepReader } from "../src/agy-outcome.js";
import { answer, configOptions, fakeAgy, SESSION, tick, type FakeAgy, type FakeAgyOptions } from "./helpers/fake-agy.js";
import { writeLaunchMessage, writeReport, writeSubagent } from "./helpers/agy-brain.js";
import type { RpcMessage } from "./helpers/fake-child.js";

const homes: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "agy-home-"));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  vi.useRealTimers();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open(agy: FakeAgy, options: Partial<CreateAgySessionOptions> = {}) {
  return createAgySession({
    cwd: "/tmp/project",
    spawnFn: agy.spawnFn,
    env: { HOME: home() },
    stepReader: null,
    replyQuietMs: 30,
    ...options,
  });
}

function setup(options: FakeAgyOptions = {}) {
  return fakeAgy(options);
}

const methods = (agy: FakeAgy) => agy.requests.map((message) => message.method).filter(Boolean);

describe("opening an agy session", () => {
  it("initializes with protocol 2, signs in, and answers a turn with usage", async () => {
    const agy = setup({ onPrompt: answer("hello", 10051) });
    const session = await open(agy);
    const usage: unknown[] = [];
    const result = await session.runTurn({ prompt: "hi", onUsage: (snapshot) => usage.push(snapshot) });

    const initialize = agy.requests.find((message) => message.method === "initialize")!;
    expect(initialize).toMatchObject({
      jsonrpc: "2.0",
      params: {
        protocolVersion: 2,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { notices: {}, compaction: {} } },
        clientInfo: { name: "agent-cli-runner" },
      },
    });
    expect(methods(agy).slice(0, 3)).toEqual(["initialize", "authenticate", "session/new"]);
    expect(agy.requests.find((message) => message.method === "authenticate")?.params).toEqual({ methodId: "oauth-personal" });
    expect(result).toEqual({
      text: "hello",
      exitCode: 0,
      sessionId: SESSION,
      usage: {
        contextTokens: 10051, inputTokens: 10, cachedInputTokens: 3, outputTokens: 5,
        model: "gemini-3.8-flash", contextWindow: 1_048_576,
      },
    });
    expect(usage.at(-1)).toEqual(result.usage);
    await session.close();
    expect(session.closed).toBe(true);
    expect(methods(agy)).toContain("session/close");
  });

  it("turns agy's sign-in link into AgyAuthError and closes the process", async () => {
    const agy = setup({
      onRequest(message, fake) {
        if (message.method !== "authenticate") return false;
        fake.child.stdout.write("Open the following link to authenticate the ACP server: https://accounts.example/auth?x=1\n");
        return true;
      },
    });
    const error = await open(agy).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgyAuthError);
    expect(error).toBeInstanceOf(ProviderTurnError);
    expect(error).toMatchObject({ provider: "agy", kind: "auth_required", url: "https://accounts.example/auth?x=1" });
    expect(agy.child.kill).toHaveBeenCalled();
  });

  it("maps -32000 at startup to AgyAuthError", async () => {
    const agy = setup({
      onRequest(message, fake) {
        if (message.method !== "authenticate") return false;
        fake.fail(message.id, { code: -32000, message: "Authentication required" });
        return true;
      },
    });
    await expect(open(agy)).rejects.toMatchObject({ name: "AgyAuthError", code: -32000 });
  });

  it("refuses an agy older than 1.5.0", async () => {
    const agy = setup({ version: "1.4.9" });
    await expect(open(agy)).rejects.toMatchObject({ name: "AgyTurnError", kind: "unsupported", code: "unsupported_version" });
    expect(agy.child.kill).toHaveBeenCalled();
  });

  it("sends the appended system prompt in _meta when agy offers it, and in the prompt otherwise", async () => {
    const withMeta = setup({ onPrompt: answer("ok") });
    const a = await open(withMeta, { appendSystemPrompt: "Be brief." });
    await a.runTurn({ prompt: "hi" });
    expect(withMeta.requests.find((message) => message.method === "session/new")?.params).toMatchObject({
      _meta: { antigravity: { systemPrompt: { append: "Be brief." } } },
    });
    expect(withMeta.prompts()[0]?.params?.prompt).toEqual([{ type: "text", text: "hi" }]);
    await a.close();

    const without = setup({ appendCapability: false, onPrompt: answer("ok") });
    const b = await open(without, { appendSystemPrompt: "Be brief." });
    await b.runTurn({ prompt: "hi" });
    expect(without.requests.find((message) => message.method === "session/new")?.params).not.toHaveProperty("_meta");
    expect(without.prompts()[0]?.params?.prompt).toEqual([{ type: "text", text: "Be brief.\n\nhi" }]);
    // A slash command only works at the start of the prompt.
    await b.runTurn({ prompt: "/plan tidy up" });
    await b.compact({ instructions: "keep notes" });
    expect(without.prompts().slice(1).map((message) => message.params?.prompt)).toEqual([
      [{ type: "text", text: "/plan tidy up" }],
      [{ type: "text", text: "/compact keep notes" }],
    ]);
    await b.close();
  });

  it("rejects a failed resume instead of opening a new session", async () => {
    const agy = setup({
      onRequest(message, fake) {
        if (message.method !== "session/resume") return false;
        fake.fail(message.id, { code: -32602, message: "Session not found" });
        return true;
      },
    });
    const error = await open(agy, { resumeSessionId: "gone-1" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgyTurnError);
    expect(error).toMatchObject({ code: -32602 });
    expect(methods(agy)).not.toContain("session/new");
    expect(agy.child.kill).toHaveBeenCalled();

    const signedOut = setup({
      onRequest(message, fake) {
        if (message.method !== "session/resume") return false;
        fake.fail(message.id, { code: -32000, message: "Authentication required" });
        return true;
      },
    });
    await expect(open(signedOut, { resumeSessionId: "s-1" })).rejects.toBeInstanceOf(AgyAuthError);
  });

  it("sends mcpServers in ACP's shape", async () => {
    const agy = setup();
    const session = await open(agy, {
      mcpServers: [
        { name: "x", command: "node", args: ["s.js"], env: { A: "1" } },
        { type: "http", name: "h", url: "https://mcp.example", headers: { Authorization: "Bearer t" } },
      ],
    });
    expect(agy.requests.find((message) => message.method === "session/new")?.params?.mcpServers).toEqual([
      { name: "x", command: "node", args: ["s.js"], env: [{ name: "A", value: "1" }] },
      { type: "http", name: "h", url: "https://mcp.example", headers: [{ name: "Authorization", value: "Bearer t" }] },
    ]);
    await session.close();
  });
});

describe("model, effort and mode", () => {
  const setOptions = (agy: FakeAgy) => agy.requests
    .filter((message) => message.method === "session/set_config_option")
    .map((message) => [message.params?.configId, message.params?.value]);

  it("returns to the session's settings on a turn without overrides", async () => {
    const agy = setup({ onPrompt: answer("ok") });
    const session = await open(agy, { mode: "default", model: "gemini-3.8-flash" });
    expect(setOptions(agy)).toEqual([]);
    await session.runTurn({ prompt: "one", mode: "auto", model: "claude-sonnet-4-6" });
    expect(setOptions(agy)).toEqual([["mode", "auto"], ["model", "claude-sonnet-4-6"]]);
    await session.runTurn({ prompt: "two" });
    expect(setOptions(agy).slice(2)).toEqual([["mode", "default"], ["model", "gemini-3.8-flash"]]);
    await session.close();
  });

  it("returns to agy's own settings when the session was opened without any", async () => {
    const agy = setup({ onPrompt: answer("ok") });
    const session = await open(agy);
    await session.runTurn({ prompt: "one", mode: "plan", effort: "low" });
    await session.runTurn({ prompt: "two", model: "claude-sonnet-4-6" });
    await session.runTurn({ prompt: "three" });
    expect(setOptions(agy)).toEqual([
      ["mode", "plan"], ["thought_level", "low"],
      ["mode", "default"], ["model", "claude-sonnet-4-6"],
      ["model", "gemini-3.8-flash"],
    ]);
    await session.close();
  });

  it("takes the model id default as the model agy opened with", async () => {
    const agy = setup({ onPrompt: answer("ok") });
    const session = await open(agy, { model: "claude-sonnet-4-6" });
    await session.runTurn({ prompt: "x", model: "default" });
    expect(setOptions(agy)).toEqual([["model", "claude-sonnet-4-6"], ["model", "gemini-3.8-flash"]]);
    await session.close();
  });

  it("forgets a sent model once agy reports another one", async () => {
    const agy = setup({ onPrompt: answer("ok") });
    const session = await open(agy);
    await session.runTurn({ prompt: "x", model: "gemini-3.8-flash-high" });
    agy.update({ sessionUpdate: "config_option_update", configOptions: configOptions({ model: "claude-sonnet-4-6" }) });
    await tick();
    await session.runTurn({ prompt: "y", model: "gemini-3.8-flash-high" });
    expect(setOptions(agy)).toEqual([["model", "gemini-3.8-flash-high"], ["model", "gemini-3.8-flash-high"]]);
    await session.close();
  });

  it("starts the next turn only after an aborted turn's setting request answers", async () => {
    const held: RpcMessage[] = [];
    const agy = setup({
      onPrompt: answer("ok"),
      onRequest: (message) => {
        if (message.method !== "session/set_config_option" || held.length > 0) return false;
        held.push(message);
        return true;
      },
    });
    const session = await open(agy);
    const controller = new AbortController();
    const first = session.runTurn({ prompt: "x", model: "claude-sonnet-4-6", signal: controller.signal });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    controller.abort();
    await expect(first).rejects.toBeInstanceOf(AbortError);
    const second = session.runTurn({ prompt: "y" });
    await tick();
    agy.respond(held[0]!.id, { configOptions: configOptions({ model: "claude-sonnet-4-6" }) });
    expect((await second).text).toBe("ok");
    expect(agy.prompts()).toHaveLength(1);
    // The second turn put agy's own model back before it prompted.
    const order = agy.requests.filter((message) => message.method === "session/set_config_option" || message.method === "session/prompt")
      .map((message) => message.method === "session/prompt" ? "prompt" : message.params?.value);
    expect(order).toEqual(["claude-sonnet-4-6", "gemini-3.8-flash", "prompt"]);
    await session.close();
  });

  it("rejects an unlisted model, sends a legacy id as-is, and checks efforts", async () => {
    const agy = setup({ onPrompt: answer("ok") });
    const session = await open(agy);
    await expect(session.runTurn({ prompt: "x", model: "nope" })).rejects.toMatchObject({
      name: "AgyTurnError", kind: "invalid_request", code: "model_unavailable",
    });
    await session.runTurn({ prompt: "x", model: "gemini-3.8-flash-high" });
    expect(setOptions(agy)).toContainEqual(["model", "gemini-3.8-flash-high"]);
    const error = await session.runTurn({ prompt: "x", effort: "max" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "invalid_request", code: "effort_unavailable" });
    expect((error as Error).message).toContain("low, medium, high");
    await session.runTurn({ prompt: "x", effort: "low" });
    expect(setOptions(agy)).toContainEqual(["thought_level", "low"]);
    await session.close();
  });

  it("ignores an effort for a model without thinking levels", async () => {
    const agy = setup({ onPrompt: answer("ok") });
    const session = await open(agy);
    await session.runTurn({ prompt: "x", model: "claude-sonnet-4-6", effort: "high" });
    expect(setOptions(agy)).toEqual([["model", "claude-sonnet-4-6"]]);
    await session.close();
  });

  it("rejects a mode agy does not offer", async () => {
    const agy = setup({ onPrompt: answer("ok") });
    const session = await open(agy);
    await expect(session.runTurn({ prompt: "x", mode: "yolo" })).rejects.toMatchObject({ code: "mode_unavailable" });
    await session.close();
  });
});

describe("a turn's stream", () => {
  it("splits prose at tool calls and reports tools once", async () => {
    const agy = setup({
      onPrompt(message, fake) {
        fake.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me " } });
        fake.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "look." } });
        const call = { toolCallId: "call_1", name: "run_command", kind: "execute", title: "false", rawInput: { CommandLine: "false" } };
        fake.update({ sessionUpdate: "tool_call", ...call, status: "in_progress" });
        fake.update({ sessionUpdate: "tool_call_update", ...call, status: "pending" });
        fake.update({ sessionUpdate: "tool_call_update", ...call, status: "completed", rawOutput: { output: "", exit_code: 1 } });
        fake.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It failed." } });
        fake.update({
          sessionUpdate: "plan",
          entries: [
            { content: "a", status: "completed" }, { content: "b", status: "pending" }, { content: "c", status: "pending" },
          ],
        });
        fake.respond(message.id, { stopReason: "end_turn" });
      },
    });
    const session = await open(agy);
    const deltas: string[] = [];
    const texts: string[] = [];
    const uses: unknown[] = [];
    const results: unknown[] = [];
    const result = await session.runTurn({
      prompt: "x",
      onAssistantTextDelta: (delta) => deltas.push(delta),
      onAssistantText: (text) => texts.push(text),
      onToolUse: (use) => uses.push(use),
      onToolResult: (toolResult) => results.push(toolResult),
    });
    expect(deltas.join("")).toBe("Let me look.It failed.");
    expect(texts).toEqual(["Let me look.", "It failed."]);
    expect(result.text).toBe("It failed.");
    expect(uses[0]).toEqual({ callId: "call_1", name: "Bash", summary: "false", input: { CommandLine: "false" } });
    expect(uses[1]).toMatchObject({ callId: `${SESSION}:plan`, name: "TodoWrite", summary: "1/3 steps completed" });
    expect(uses).toHaveLength(2);
    expect(results).toEqual([{ callId: "call_1", content: { output: "", exit_code: 1 }, isError: true, structured: { output: "", exit_code: 1 } }]);
    await session.close();
  });

  it("sends images as base64 blocks, and refuses ones agy can't take", async () => {
    const dir = home();
    writeFileSync(join(dir, "a.png"), Buffer.from([1, 2, 3]));
    writeFileSync(join(dir, "a.tiff"), Buffer.from([1]));
    const agy = setup({ onPrompt: answer("ok") });
    const session = await open(agy);
    await session.runTurn({ prompt: "see", imagePaths: [join(dir, "a.png")] });
    expect(agy.prompts()[0]?.params?.prompt).toEqual([
      { type: "text", text: "see" },
      { type: "image", mimeType: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") },
    ]);
    await expect(session.runTurn({ prompt: "see", imagePaths: [join(dir, "a.tiff")] })).rejects.toMatchObject({ code: "unsupported_image" });
    mkdirSync(join(dir, "folder.png"));
    await expect(session.runTurn({ prompt: "see", imagePaths: [join(dir, "folder.png")] })).rejects.toMatchObject({ code: "unsupported_image" });
    expect(agy.prompts()).toHaveLength(1);
    await session.close();

    const blind = setup({ image: false, onPrompt: answer("ok") });
    const other = await open(blind);
    await expect(other.runTurn({ prompt: "see", imagePaths: [join(dir, "a.png")] })).rejects.toMatchObject({ code: "images_unsupported" });
    await other.close();
  });
});

describe("permission requests", () => {
  const OPTIONS = [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "always", name: "Allow for this thread", kind: "allow_always" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ];

  async function askDuringTurn(options: Partial<CreateAgySessionOptions>, toolCallId: string, onPermissionRequest?: (request: AgyPermissionRequest) => Promise<string>) {
    const agy = setup({
      onPrompt(message, fake) {
        fake.ask("p1", "session/request_permission", {
          sessionId: SESSION,
          toolCall: { toolCallId, name: "run_command", kind: "execute", title: "rm x", rawInput: { CommandLine: "rm x" } },
          options: OPTIONS,
        });
        setTimeout(() => fake.respond(message.id, { stopReason: "end_turn" }), 20);
      },
    });
    const session = await open(agy, options);
    await session.runTurn({ prompt: "x", ...(onPermissionRequest ? { onPermissionRequest } : {}) });
    await session.close();
    return agy.requests.find((message) => message.id === "p1" && message.method === undefined);
  }

  it("denies an approval and cancels a question when the host gave no callback", async () => {
    expect((await askDuringTurn({}, "call_1"))?.result).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect((await askDuringTurn({}, "interaction_1"))?.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("allows once, never always, when permissions are skipped", async () => {
    expect((await askDuringTurn({ dangerouslySkipPermissions: true }, "call_1"))?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
  });

  it("hands the request to the callback and sends its answer", async () => {
    const seen: AgyPermissionRequest[] = [];
    const reply = await askDuringTurn({}, "call_1", async (request) => {
      seen.push(request);
      return "always";
    });
    expect(reply?.result).toEqual({ outcome: { outcome: "selected", optionId: "always" } });
    expect(seen[0]).toMatchObject({ kind: "approval", toolCall: { callId: "call_1", name: "Bash", summary: "rm x" } });
    expect(seen[0]?.options.map((option) => option.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
  });

  it("cancels a pending request when the turn ends", async () => {
    const reply = await askDuringTurn({}, "call_1", () => new Promise<string>(() => {}));
    expect(reply?.result).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

describe("steering", () => {
  it("sends a second prompt and settles after both answer", async () => {
    let first: RpcMessage | undefined;
    const agy = setup({
      onPrompt(message, fake) {
        if (!first) {
          first = message;
          return;
        }
        fake.respond(first.id, { stopReason: "end_turn" });
        answer("both done")(message, fake);
      },
    });
    const session = await open(agy);
    const turn = session.runTurn({ prompt: "start" });
    await vi.waitFor(() => expect(agy.prompts()).toHaveLength(1));
    await session.steer({ prompt: "also this" });
    const result = await turn;
    expect(agy.prompts().map((message) => message.params?.prompt)).toEqual([
      [{ type: "text", text: "start" }],
      [{ type: "text", text: "also this" }],
    ]);
    expect(result.text).toBe("both done");
    await expect(session.steer({ prompt: "late" })).rejects.toBeInstanceOf(SteerRejectedError);
    await session.close();
  });
});

function stepReader(step: { type: number; text?: string; reachedModel?: boolean } | undefined): AgyStepReader {
  return {
    lastIndex: () => 4,
    lastStepAfter: () => step && {
      type: step.type,
      payload: step.text === undefined ? null : new TextEncoder().encode(step.text),
      reachedModel: step.reachedModel ?? false,
    },
  };
}

describe("turn outcomes from agy's step log", () => {
  async function turnWith(step: Parameters<typeof stepReader>[0], stopReason = "end_turn") {
    const dir = home();
    mkdirSync(join(dir, ".gemini", "antigravity-cli", "conversations"), { recursive: true });
    writeFileSync(join(dir, ".gemini", "antigravity-cli", "conversations", `${SESSION}.db`), "");
    const agy = setup({ onPrompt: (message, fake) => fake.respond(message.id, { stopReason }) });
    const session = await open(agy, { env: { HOME: dir }, stepReader: stepReader(step) });
    const outcome = await session.runTurn({ prompt: "x" }).then((value) => ({ value }), (error: unknown) => ({ error }));
    return { session, outcome, agy };
  }

  it("rejects a rate limit as a retryable usage limit", async () => {
    const { session, outcome } = await turnWith({ type: 17, text: "RESOURCE_EXHAUSTED (code 429): Slow down. retryDelay:30s ]" });
    expect("error" in outcome && outcome.error).toMatchObject({
      name: "AgyTurnError", provider: "agy", kind: "usage_limit", retryable: true, code: "RESOURCE_EXHAUSTED",
    });
    expect(("error" in outcome && (outcome.error as AgyTurnError).resetAt)).toBeTruthy();
    expect(session.closed).toBe(false);
    expect(session.outcomeSource).toBe("steps-db");
    await session.close();
  });

  it("closes the session on a broken conversation", async () => {
    const { session, outcome } = await turnWith({ type: 17, text: "messages.2.content.0: Invalid `signature` in `thinking` block" });
    expect("error" in outcome && outcome.error).toMatchObject({ broken: true });
    await vi.waitFor(() => expect(session.closed).toBe(true));
  });

  it("marks a 404 after the model answered retryable, without another prompt", async () => {
    const { session, outcome, agy } = await turnWith({ type: 17, text: "NOT_FOUND (code 404): gone", reachedModel: true });
    expect("error" in outcome && outcome.error).toMatchObject({ kind: "provider_error", retryable: true });
    expect(agy.prompts()).toHaveLength(1);
    expect(session.closed).toBe(false);
    await session.close();
  });

  it("falls back to the stop reason with no step reader", async () => {
    const agy = setup({ onPrompt: (message, fake) => fake.respond(message.id, { stopReason: "refusal" }) });
    const session = await open(agy, { stepReader: null });
    expect(session.outcomeSource).toBe("stop-reason");
    await expect(session.runTurn({ prompt: "x" })).rejects.toMatchObject({ kind: "usage_limit", retryable: true });
    await session.close();
    const clean = setup({ onPrompt: answer("fine") });
    const other = await open(clean, { stepReader: null });
    await expect(other.runTurn({ prompt: "x" })).resolves.toMatchObject({ text: "fine" });
    await other.close();
  });
});

describe("background work", () => {
  const subagentCall = (id: string, role: string) => ({
    toolCallId: id, name: "invoke_subagent", kind: "other", title: "Run invoke_subagent",
    rawInput: { Prompt: "work", Role: role, TypeName: "self" },
  });

  it("holds the turn until every subagent has reported", async () => {
    const dir = home();
    const root = join(dir, ".gemini", "antigravity-cli");
    const agy = setup({
      onPrompt(message, fake) {
        for (const [id, role] of [["call_fast", "Fast"], ["call_slow", "Slow"]] as const) {
          fake.update({ sessionUpdate: "tool_call", ...subagentCall(id, role), status: "in_progress" });
          fake.update({ sessionUpdate: "tool_call_update", ...subagentCall(id, role), status: "completed" });
        }
        writeSubagent(root, SESSION, "fast-1", { role: "Fast" });
        writeLaunchMessage(root, SESSION, "fast-1", "call_fast");
        writeSubagent(root, SESSION, "slow-1", { role: "Slow" });
        writeLaunchMessage(root, SESSION, "slow-1", "call_slow");
        fake.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STARTED" } });
        fake.respond(message.id, { stopReason: "end_turn" });
      },
    });
    const session = await open(agy, { env: { HOME: dir } });
    const updates: BackgroundAgentInfo[] = [];
    let settled = false;
    const turn = session.runTurn({ prompt: "go", onBackgroundAgentUpdate: (info) => updates.push(info) });
    void turn.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(updates.filter((info) => info.status === "running")).toHaveLength(2));
    await tick();
    expect(settled).toBe(false);

    writeReport(root, SESSION, "fast-1", "m1", "fast-done", "2026-11-20T22:04:22.957Z");
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FAST reported." } });
    agy.update({ sessionUpdate: "usage_update", used: 11692, size: 1_048_576 });
    await vi.waitFor(() => expect(updates.find((info) => info.id === "call_fast" && info.status === "completed")).toBeDefined());
    expect(updates.find((info) => info.id === "call_fast" && info.status === "completed")).toMatchObject({
      provider: "agy", parentToolCallId: "call_fast", description: "Fast", agentType: "self", summary: "fast-done",
    });
    await tick();
    expect(settled).toBe(false);

    writeReport(root, SESSION, "slow-1", "m2", "slow-done", "2026-11-20T22:04:46.759Z");
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "SLOW reported." } });
    agy.update({ sessionUpdate: "usage_update", used: 11928, size: 1_048_576 });
    const result = await turn;
    expect(result.text).toBe("SLOW reported.");
    await session.close();
  });

  it("keeps two replies apart when the second starts before the first's quiet time is over", async () => {
    const dir = home();
    const root = join(dir, ".gemini", "antigravity-cli");
    const agy = setup({
      onPrompt(message, fake) {
        for (const [id, role] of [["call_a", "A"], ["call_b", "B"]] as const) {
          fake.update({ sessionUpdate: "tool_call", ...subagentCall(id, role), status: "in_progress" });
          fake.update({ sessionUpdate: "tool_call_update", ...subagentCall(id, role), status: "completed" });
        }
        for (const [child, call] of [["a-1", "call_a"], ["b-1", "call_b"]] as const) {
          writeSubagent(root, SESSION, child);
          writeLaunchMessage(root, SESSION, child, call);
        }
        fake.respond(message.id, { stopReason: "end_turn" });
      },
    });
    const session = await open(agy, { env: { HOME: dir }, replyQuietMs: 200 });
    const texts: string[] = [];
    const updates: BackgroundAgentInfo[] = [];
    const turn = session.runTurn({ prompt: "go", onAssistantText: (text) => texts.push(text), onBackgroundAgentUpdate: (info) => updates.push(info) });
    await vi.waitFor(() => expect(updates.filter((info) => info.status === "running")).toHaveLength(2));
    await tick();
    writeReport(root, SESSION, "a-1", "m1", "a-done", "2026-11-20T22:04:22.957Z");
    writeReport(root, SESSION, "b-1", "m2", "b-done", "2026-11-20T22:04:23.957Z");
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A reported." } });
    agy.update({ sessionUpdate: "usage_update", used: 100, size: 1_048_576 });
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "B reported." } });
    agy.update({ sessionUpdate: "usage_update", used: 120, size: 1_048_576 });
    expect((await turn).text).toBe("B reported.");
    expect(texts).toEqual(["A reported.", "B reported."]);
    await session.close();
  });

  it("resolves at once when the subagent had already reported", async () => {
    const dir = home();
    const root = join(dir, ".gemini", "antigravity-cli");
    const agy = setup({
      onPrompt(message, fake) {
        fake.update({ sessionUpdate: "tool_call", ...subagentCall("call_1", "Runner"), status: "in_progress" });
        fake.update({ sessionUpdate: "tool_call_update", ...subagentCall("call_1", "Runner"), status: "completed" });
        writeSubagent(root, SESSION, "child-1");
        writeLaunchMessage(root, SESSION, "child-1", "call_1");
        writeReport(root, SESSION, "child-1", "m1", "waited-done", "2026-11-20T22:07:00.000Z");
        answer("waited-done")(message, fake);
      },
    });
    const session = await open(agy, { env: { HOME: dir } });
    const updates: BackgroundAgentInfo[] = [];
    const result = await session.runTurn({ prompt: "go", onBackgroundAgentUpdate: (info) => updates.push(info) });
    expect(result.text).toBe("waited-done");
    expect(updates.at(-1)).toMatchObject({ id: "call_1", status: "completed", summary: "waited-done" });
    await session.close();
  });

  it("waits for a command that outlives the prompt, but not for a daemon", async () => {
    const command = { toolCallId: "call_c", name: "run_command", kind: "execute", title: "sleep 8", rawInput: { CommandLine: "sleep 8" } };
    const agy = setup({
      onPrompt(message, fake) {
        fake.update({ sessionUpdate: "tool_call", ...command, status: "in_progress" });
        fake.respond(message.id, { stopReason: "end_turn" });
      },
    });
    const session = await open(agy);
    let settled = false;
    const turn = session.runTurn({ prompt: "go" });
    void turn.then(() => { settled = true; }, () => { settled = true; });
    await tick();
    await tick();
    expect(settled).toBe(false);
    agy.update({ sessionUpdate: "tool_call_update", ...command, status: "completed", rawOutput: { output: "slept", exit_code: 0 } });
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It slept." } });
    agy.update({ sessionUpdate: "usage_update", used: 50, size: 1_048_576 });
    expect((await turn).text).toBe("It slept.");
    await session.close();

    const daemon = { ...command, toolCallId: "call_d", rawInput: { CommandLine: "serve", IsDaemon: true } };
    const other = setup({
      onPrompt(message, fake) {
        fake.update({ sessionUpdate: "tool_call", ...daemon, status: "in_progress" });
        answer("serving")(message, fake);
      },
    });
    const second = await open(other);
    expect((await second.runTurn({ prompt: "go" })).text).toBe("serving");
    await second.close();
  });

  it("stops waiting for a held command after commandHoldMs, ending with the reply it has", async () => {
    const command = { toolCallId: "call_c", name: "run_command", kind: "execute", title: "find ~", rawInput: { CommandLine: "find ~ -name x" } };
    const agy = setup({
      onPrompt(message, fake) {
        fake.update({ sessionUpdate: "tool_call", ...command, status: "in_progress" });
        fake.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Here is the plan." } });
        fake.respond(message.id, { stopReason: "end_turn" });
      },
    });
    const session = await open(agy, { commandHoldMs: 100 });
    let settled = false;
    const turn = session.runTurn({ prompt: "go" });
    void turn.then(() => { settled = true; }, () => { settled = true; });
    await tick();
    await tick();
    expect(settled).toBe(false);
    expect((await turn).text).toBe("Here is the plan.");
    // The command ending later finds no turn open; the session carries on.
    agy.update({ sessionUpdate: "tool_call_update", ...command, status: "completed", rawOutput: { output: "found", exit_code: 0 } });
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It found nothing." } });
    agy.update({ sessionUpdate: "usage_update", used: 50, size: 1_048_576 });
    await tick();
    expect(session.closed).toBe(false);
    await session.close();
  });

  it("lets a reply that follows a held command finish, even past commandHoldMs", async () => {
    const command = { toolCallId: "call_c", name: "run_command", kind: "execute", title: "npm test", rawInput: { CommandLine: "npm test" } };
    const agy = setup({
      onPrompt(message, fake) {
        fake.update({ sessionUpdate: "tool_call", ...command, status: "in_progress" });
        fake.respond(message.id, { stopReason: "end_turn" });
      },
    });
    const session = await open(agy, { commandHoldMs: 120, replyQuietMs: 150 });
    const turn = session.runTurn({ prompt: "go" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    // The command ends just before the limit, and agy starts telling what it found.
    agy.update({ sessionUpdate: "tool_call_update", ...command, status: "completed", rawOutput: { output: "ok", exit_code: 0 } });
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The command finished: " } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "all 12 tests pass." } });
    agy.update({ sessionUpdate: "usage_update", used: 50, size: 1_048_576 });
    expect((await turn).text).toBe("The command finished: all 12 tests pass.");
    await session.close();
  });

  it("refuses a commandHoldMs that isn't a positive number", async () => {
    const agy = setup();
    await expect(open(agy, { commandHoldMs: 0 })).rejects.toThrow(/commandHoldMs/);
  });

  it("keeps holding for a running subagent past commandHoldMs", async () => {
    const dir = home();
    const root = join(dir, ".gemini", "antigravity-cli");
    const agy = setup({
      onPrompt(message, fake) {
        fake.update({ sessionUpdate: "tool_call", ...subagentCall("call_slow", "Slow"), status: "in_progress" });
        fake.update({ sessionUpdate: "tool_call_update", ...subagentCall("call_slow", "Slow"), status: "completed" });
        writeSubagent(root, SESSION, "slow-1", { role: "Slow" });
        writeLaunchMessage(root, SESSION, "slow-1", "call_slow");
        fake.respond(message.id, { stopReason: "end_turn" });
      },
    });
    const session = await open(agy, { env: { HOME: dir }, commandHoldMs: 50 });
    let settled = false;
    const turn = session.runTurn({ prompt: "go" });
    void turn.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);
    void session.close();
    await turn.catch(() => {});
  });

  it("still stops waiting for a command that a subagent's report leaves running, after holding for the subagent", async () => {
    const dir = home();
    const root = join(dir, ".gemini", "antigravity-cli");
    const agy = setup({
      onPrompt(message, fake) {
        fake.update({ sessionUpdate: "tool_call", ...subagentCall("call_slow", "Slow"), status: "in_progress" });
        fake.update({ sessionUpdate: "tool_call_update", ...subagentCall("call_slow", "Slow"), status: "completed" });
        writeSubagent(root, SESSION, "slow-1", { role: "Slow" });
        writeLaunchMessage(root, SESSION, "slow-1", "call_slow");
        fake.respond(message.id, { stopReason: "end_turn" });
      },
    });
    const session = await open(agy, { env: { HOME: dir }, commandHoldMs: 50, replyQuietMs: 30 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await holdThenReport(session, agy, root);
    } finally {
      vi.useRealTimers();
    }
    await session.close();
  });

  async function holdThenReport(session: Awaited<ReturnType<typeof open>>, agy: ReturnType<typeof setup>, root: string): Promise<void> {
    let running = false;
    const turn = session.runTurn({ prompt: "go", onBackgroundAgentUpdate: (info) => { if (info.status === "running") running = true; } });
    let ended = false;
    void turn.then(() => { ended = true; }, () => {});
    // The turn holds for the subagent once agy has answered and its files are read, which takes real time.
    const settleBy = Date.now() + 200;
    while (!running || Date.now() < settleBy) await new Promise((resolve) => setImmediate(resolve));
    // Past several hold limits with only the subagent running, the file reads between them given real time.
    for (let step = 0; step < 10; step++) {
      await vi.advanceTimersByTimeAsync(50);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(ended).toBe(false);
    // The subagent reports, and agy's answer to it starts a command it leaves running.
    writeReport(root, SESSION, "slow-1", "m1", "slow-done", "2026-11-20T22:04:46.759Z");
    const command = { toolCallId: "call_c", name: "run_command", kind: "execute", title: "npm test", rawInput: { CommandLine: "npm test" } };
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Slow is done; running the tests." } });
    agy.update({ sessionUpdate: "tool_call", ...command, status: "in_progress" });
    agy.update({ sessionUpdate: "usage_update", used: 100, size: 1_048_576 });
    // A reply that leaves a command running counts as open for two minutes; past that, only the command holds the turn.
    await vi.advanceTimersByTimeAsync(120_000);
    // The checks read agy's files, which takes real time: step the clock while they do.
    for (let step = 0; step < 100 && !ended; step++) {
      await vi.advanceTimersByTimeAsync(50);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(ended).toBe(true);
    expect((await turn).text).toBe("Slow is done; running the tests.");
  }

  it("waits out a usage update in the middle of the reply that follows a held command", async () => {
    const command = { toolCallId: "call_c", name: "run_command", kind: "execute", title: "sleep 8", rawInput: { CommandLine: "sleep 8" } };
    const read = { toolCallId: "call_r", name: "view_file", kind: "read", title: "Read out.txt", rawInput: { AbsolutePath: "/tmp/project/out.txt" } };
    const agy = setup({
      onPrompt(message, fake) {
        fake.update({ sessionUpdate: "tool_call", ...command, status: "in_progress" });
        fake.respond(message.id, { stopReason: "end_turn" });
      },
    });
    const session = await open(agy, { replyQuietMs: 200 });
    const turn = session.runTurn({ prompt: "go" });
    await tick();
    await tick();
    agy.update({ sessionUpdate: "tool_call_update", ...command, status: "completed", rawOutput: { output: "slept", exit_code: 0 } });
    agy.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Let me read the output." } });
    agy.update({ sessionUpdate: "usage_update", used: 40, size: 1_048_576 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    agy.update({ sessionUpdate: "tool_call", ...read, status: "in_progress" });
    agy.update({ sessionUpdate: "tool_call_update", ...read, status: "completed", rawOutput: { content: "done" } });
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It printed done." } });
    agy.update({ sessionUpdate: "usage_update", used: 60, size: 1_048_576 });
    expect((await turn).text).toBe("It printed done.");
    await session.close();
  });

  it("ends a hold on a held command at the reply's usage update while a daemon runs on", async () => {
    const command = { toolCallId: "call_c", name: "run_command", kind: "execute", title: "sleep 8", rawInput: { CommandLine: "sleep 8" } };
    const daemon = { ...command, toolCallId: "call_d", title: "serve", rawInput: { CommandLine: "serve", IsDaemon: true } };
    const agy = setup({
      onPrompt(message, fake) {
        fake.update({ sessionUpdate: "tool_call", ...daemon, status: "in_progress" });
        fake.update({ sessionUpdate: "tool_call", ...command, status: "in_progress" });
        fake.respond(message.id, { stopReason: "end_turn" });
      },
    });
    const session = await open(agy);
    const turn = session.runTurn({ prompt: "go" });
    await tick();
    await tick();
    agy.update({ sessionUpdate: "tool_call_update", ...command, status: "completed", rawOutput: { output: "slept", exit_code: 0 } });
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It slept." } });
    agy.update({ sessionUpdate: "usage_update", used: 50, size: 1_048_576 });
    await vi.waitFor(async () => expect(await Promise.race([turn.then((result) => result.text), tick().then(() => "pending")])).toBe("It slept."));
    await session.close();
  });

  it("stops waiting for a subagent agy left no record of", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const agy = setup({
      onPrompt(message, fake) {
        fake.update({ sessionUpdate: "tool_call", ...subagentCall("call_1", "R"), status: "in_progress" });
        fake.update({ sessionUpdate: "tool_call_update", ...subagentCall("call_1", "R"), status: "completed" });
        fake.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STARTED" } });
        fake.respond(message.id, { stopReason: "end_turn" });
      },
    });
    const session = await open(agy);
    const updates: BackgroundAgentInfo[] = [];
    let settled = false;
    const turn = session.runTurn({ prompt: "go", onBackgroundAgentUpdate: (info) => updates.push(info) });
    void turn.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(90_000);
    await vi.waitFor(() => expect(settled).toBe(true));
    expect((await turn).text).toBe("STARTED");
    expect(updates.at(-1)).toMatchObject({ id: "call_1", status: "failed" });
    await session.close();
  });

  it("does not hold the turn for a subagent launch that failed", async () => {
    const agy = setup({
      onPrompt(message, fake) {
        fake.update({ sessionUpdate: "tool_call", ...subagentCall("call_1", "R"), status: "in_progress" });
        fake.update({ sessionUpdate: "tool_call_update", ...subagentCall("call_1", "R"), status: "failed", rawOutput: { error: "launch refused" } });
        fake.update({ sessionUpdate: "tool_call", ...subagentCall("call_2", "S"), status: "failed" });
        answer("could not start")(message, fake);
      },
    });
    const session = await open(agy);
    const updates: BackgroundAgentInfo[] = [];
    const result = await session.runTurn({ prompt: "go", onBackgroundAgentUpdate: (info) => updates.push(info) });
    expect(result.text).toBe("could not start");
    expect(updates.map((info) => [info.id, info.status])).toEqual([["call_1", "running"], ["call_1", "failed"]]);
    expect(updates.at(-1)?.endedAt).toBeDefined();
    await session.close();
  });

  it("aborts a turn held for a subagent without cancelling agy", async () => {
    const agy = setup({
      onPrompt(message, fake) {
        fake.update({ sessionUpdate: "tool_call", ...subagentCall("call_1", "R"), status: "in_progress" });
        fake.update({ sessionUpdate: "tool_call_update", ...subagentCall("call_1", "R"), status: "completed" });
        fake.respond(message.id, { stopReason: "end_turn" });
      },
    });
    const session = await open(agy);
    const controller = new AbortController();
    const updates: BackgroundAgentInfo[] = [];
    const turn = session.runTurn({ prompt: "go", signal: controller.signal, onBackgroundAgentUpdate: (info) => updates.push(info) });
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    await tick();
    controller.abort();
    await expect(turn).rejects.toBeInstanceOf(AbortError);
    expect(methods(agy)).not.toContain("session/cancel");
    expect(updates.at(-1)?.status).toBe("running");
    await session.close();
  });
});

describe("opening with an abort signal", () => {
  it("gives up during session/new when the signal aborts", async () => {
    const agy = setup({ onRequest: (message) => message.method === "session/new" });
    const controller = new AbortController();
    const opening = open(agy, { signal: controller.signal });
    await vi.waitFor(() => expect(methods(agy)).toContain("session/new"));
    controller.abort();
    await expect(opening).rejects.toBeInstanceOf(AbortError);
    expect(agy.child.kill).toHaveBeenCalled();
  });
});

describe("output with no turn open", () => {
  it("goes to onContinuation's handlers, and ends at the reply's usage update", async () => {
    const agy = setup({ onPrompt: answer("first") });
    const ended: Array<{ text: string | undefined }> = [];
    const texts: string[] = [];
    const session = await open(agy, {
      onContinuation: () => ({
        onAssistantText: (text) => texts.push(text),
        onEnd: ({ result }) => ended.push({ text: result?.text }),
      }),
    });
    await session.runTurn({ prompt: "x" });
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Daemon finished." } });
    agy.update({ sessionUpdate: "usage_update", used: 200, size: 1_048_576 });
    await vi.waitFor(() => expect(ended).toEqual([{ text: "Daemon finished." }]));
    expect(texts).toEqual(["Daemon finished."]);
    await session.close();
  });

  it("hands its text over when a new turn takes over, and refuses a turn started from its onEnd", async () => {
    const agy = setup({ onPrompt: answer("ok") });
    const ended: Array<{ text: string | undefined }> = [];
    let fromOnEnd: Promise<unknown> | undefined;
    const session = await open(agy, {
      onContinuation: () => ({
        onEnd: ({ result }) => {
          ended.push({ text: result?.text });
          fromOnEnd = session.runTurn({ prompt: "from onEnd" });
          fromOnEnd.catch(() => {});
        },
      }),
    });
    await session.runTurn({ prompt: "x" });
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Late words." } });
    await tick();
    expect((await session.runTurn({ prompt: "next" })).text).toBe("ok");
    expect(ended).toEqual([{ text: "Late words." }]);
    await expect(fromOnEnd).rejects.toThrow("already has an active turn");
    await session.close();
  });

  it("is dropped, and permission requests cancelled, without onContinuation", async () => {
    const agy = setup({ onPrompt: answer("first") });
    const session = await open(agy);
    const texts: string[] = [];
    await session.runTurn({ prompt: "x", onAssistantText: (text) => texts.push(text) });
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } });
    agy.ask("p9", "session/request_permission", {
      sessionId: SESSION,
      toolCall: { toolCallId: "call_9", name: "run_command" },
      options: [{ optionId: "deny", kind: "reject_once" }, { optionId: "allow", kind: "allow_once" }],
    });
    await vi.waitFor(() => expect(agy.requests.find((message) => message.id === "p9" && !message.method)).toBeDefined());
    expect(agy.requests.find((message) => message.id === "p9" && !message.method)?.result).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(texts).toEqual(["first"]);
    await session.close();
  });
});

describe("abort and timeout", () => {
  it("honours an abort fired from onSessionId", async () => {
    const agy = setup({ onPrompt: answer("ok") });
    const session = await open(agy);
    const controller = new AbortController();
    await expect(session.runTurn({ prompt: "x", signal: controller.signal, onSessionId: () => controller.abort() }))
      .rejects.toBeInstanceOf(AbortError);
    await session.runTurn({ prompt: "next" });
    expect(agy.prompts().map((message) => (message.params?.prompt as Array<{ text: string }>)[0]!.text)).toEqual(["next"]);
    await session.close();
  });

  it("cancels the prompt and keeps the session usable when agy answers", async () => {
    const agy = setup({
      onRequest(message, fake) {
        if (message.method !== "session/cancel") return false;
        const prompt = fake.prompts().at(-1)!;
        fake.respond(prompt.id, { stopReason: "cancelled" });
        return true;
      },
      onPrompt(message, fake) {
        if (fake.prompts().length > 1) answer("again")(message, fake);
      },
    });
    const session = await open(agy);
    const controller = new AbortController();
    const turn = session.runTurn({ prompt: "long", signal: controller.signal });
    await vi.waitFor(() => expect(agy.prompts()).toHaveLength(1));
    controller.abort();
    await expect(turn).rejects.toBeInstanceOf(AbortError);
    expect(session.closed).toBe(false);
    expect((await session.runTurn({ prompt: "next" })).text).toBe("again");
    await session.close();
  });

  it("closes the session when agy doesn't answer the cancel in time", async () => {
    const agy = setup();
    const session = await open(agy, { interruptGraceMs: 20 });
    const closes: Error[] = [];
    session.onClose((error) => closes.push(error));
    const turn = session.runTurn({ prompt: "long", timeoutMs: 10 });
    await expect(turn).rejects.toBeInstanceOf(TimeoutError);
    await vi.waitFor(() => expect(session.closed).toBe(true));
    expect(methods(agy)).toContain("session/cancel");
    expect(agy.child.kill).toHaveBeenCalled();
    expect(closes).toHaveLength(1);
  });

  it("fails a silent turn only when an inactivity timeout was asked for", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const agy = setup();
    const quiet = await open(agy);
    let settled = false;
    void quiet.runTurn({ prompt: "x" }).then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(settled).toBe(false);
    await quiet.close().catch(() => {});

    const other = setup();
    const watched = await open(other, { inactivityTimeoutMs: 60_000 });
    const turn = watched.runTurn({ prompt: "x" });
    const rejected = expect(turn).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(60_001);
    await rejected;
    await vi.waitFor(() => expect(watched.closed).toBe(true));
  });

  it("lets a quiet continuation end on its own rather than time out the session", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const agy = setup({ onPrompt: answer("first") });
    const ended: Array<{ text: string | undefined; error: string | undefined }> = [];
    const session = await open(agy, {
      inactivityTimeoutMs: 60_000,
      onContinuation: () => ({ onEnd: ({ result, error }) => ended.push({ text: result?.text, error: error?.name }) }),
    });
    await session.runTurn({ prompt: "x" });
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Daemon done." } });
    await vi.advanceTimersByTimeAsync(130_000);
    await vi.waitFor(() => expect(ended).toEqual([{ text: "Daemon done.", error: undefined }]));
    expect(session.closed).toBe(false);
    await session.close();
  });

  it("does not time out while a permission request is pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const agy = setup({
      onPrompt(_message, fake) {
        fake.ask("p1", "session/request_permission", {
          sessionId: SESSION,
          toolCall: { toolCallId: "call_1", name: "run_command" },
          options: [{ optionId: "deny", kind: "reject_once" }],
        });
      },
    });
    const session = await open(agy, { inactivityTimeoutMs: 60_000 });
    let settled = false;
    let asked = false;
    void session.runTurn({ prompt: "x", onPermissionRequest: () => { asked = true; return new Promise<string>(() => {}); } })
      .then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(asked).toBe(true));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(settled).toBe(false);
    await session.close().catch(() => {});
  });
});

describe("compaction", () => {
  it("sends /compact with instructions and reports the drop", async () => {
    let used = 15997;
    const agy = setup({
      onPrompt(message, fake) {
        const text = (message.params?.prompt as Array<{ text: string }>)[0]!.text;
        if (text.startsWith("/compact")) used = 10213;
        answer("compacted prose", used)(message, fake);
      },
    });
    const session = await open(agy);
    await session.runTurn({ prompt: "warm up" });
    const compactions: unknown[] = [];
    const events: string[] = [];
    const result = await session.compact({
      instructions: "keep API notes",
      onCompactionStart: (info) => events.push(`start:${info.trigger}:${agy.prompts().length}`),
      onCompaction: (info) => { compactions.push(info); events.push("done"); },
    });
    expect(agy.prompts().at(-1)?.params?.prompt).toEqual([{ type: "text", text: "/compact keep API notes" }]);
    expect(result.text).toBe("");
    expect(compactions).toEqual([{ trigger: "manual", preTokens: 15997, postTokens: 10213 }]);
    // Started as /compact went out, after the warm-up prompt.
    expect(events).toEqual(["start:manual:1", "done"]);
    await session.close();
  });

  it("goes straight to the next turn when onCompactionStart aborts", async () => {
    const agy = setup({ onPrompt: answer("ok") });
    const session = await open(agy);
    await session.runTurn({ prompt: "warm up" });
    const controller = new AbortController();
    await expect(session.compact({ signal: controller.signal, onCompactionStart: () => controller.abort() }))
      .rejects.toBeInstanceOf(AbortError);
    await session.runTurn({ prompt: "next" });
    expect(agy.prompts().map((message) => (message.params?.prompt as Array<{ text: string }>)[0]!.text)).toEqual(["warm up", "next"]);
    await session.close();
  });

  it("is refused when agy offers no compact command", async () => {
    const agy = setup({ commands: ["plan"] });
    const session = await open(agy);
    await vi.waitFor(() => expect(methods(agy)).toContain("session/new"));
    await tick();
    await expect(session.compact({})).rejects.toMatchObject({ kind: "unsupported", code: "compaction_unsupported" });
    await session.close();
  });
});

describe("isolated runs", () => {
  it("runs in a fresh temp cwd in default mode and leaves nothing behind", async () => {
    const dir = home();
    const root = join(dir, ".gemini", "antigravity-cli");
    for (const sub of ["conversations", "annotations", join("brain", SESSION)]) mkdirSync(join(root, sub), { recursive: true });
    writeFileSync(join(root, "conversations", `${SESSION}.db`), "");
    writeFileSync(join(root, "annotations", `${SESSION}.pbtxt`), "");
    writeFileSync(join(root, "conversations", "other.db"), "");
    mkdirSync(join(dir, ".gemini", "config"), { recursive: true });
    writeFileSync(join(dir, ".gemini", "config", "mcp_config.json"), JSON.stringify({ mcpServers: { x: { command: "x" } } }));
    const agy = setup({ onPrompt: answer("A title") });
    const session = await open(agy, { isolated: true, env: { HOME: dir } });
    const cwd = session.cwd;
    expect(cwd).not.toBe("/tmp/project");
    expect(cwd).toContain("agent-cli-runner-agy-");
    expect(agy.requests.find((message) => message.method === "session/new")?.params?.cwd).toBe(cwd);
    expect((await session.runTurn({ prompt: "Title this" })).text).toBe("A title");
    await session.close();
    expect(existsSync(cwd)).toBe(false);
    expect(readdirSync(join(root, "conversations"))).toEqual(["other.db"]);
    expect(existsSync(join(root, "brain", SESSION))).toBe(false);
    expect(existsSync(join(root, "annotations", `${SESSION}.pbtxt`))).toBe(false);
  });

  it("removes the session's files when opening fails after agy created it", async () => {
    const dir = home();
    const root = join(dir, ".gemini", "antigravity-cli");
    mkdirSync(join(root, "conversations"), { recursive: true });
    writeFileSync(join(root, "conversations", `${SESSION}.db`), "");
    const agy = setup({
      onRequest(message, fake) {
        if (message.method !== "session/set_config_option") return false;
        fake.fail(message.id, { code: -32603, message: "no" });
        return true;
      },
    });
    await expect(open(agy, { isolated: true, model: "claude-sonnet-4-6", env: { HOME: dir } })).rejects.toThrow();
    expect(readdirSync(join(root, "conversations"))).toEqual([]);
  });

  it("fails on any tool call and cancels agy", async () => {
    const agy = setup({
      onPrompt(_message, fake) {
        fake.update({ sessionUpdate: "tool_call", toolCallId: "call_1", name: "list_dir", kind: "read", status: "in_progress" });
      },
    });
    const session = await open(agy, { isolated: true });
    await expect(session.runTurn({ prompt: "x" })).rejects.toMatchObject({ name: "AgyTurnError", code: "tool_used" });
    expect(methods(agy)).toContain("session/cancel");
    await session.close();
  });

  it("cannot be combined with resume, MCP servers, a mode or skipped permissions", async () => {
    for (const extra of [
      { resumeSessionId: "s" },
      { mcpServers: [{ name: "x", command: "x" }] },
      { mode: "plan" },
      { dangerouslySkipPermissions: true },
    ]) {
      await expect(open(setup(), { isolated: true, ...extra })).rejects.toThrow();
    }
  });
});

describe("ephemeral sessions", () => {
  it("keep their cwd and tools, and delete the session's files on close", async () => {
    const dir = home();
    const root = join(dir, ".gemini", "antigravity-cli");
    for (const sub of ["conversations", "annotations", join("brain", SESSION)]) mkdirSync(join(root, sub), { recursive: true });
    writeFileSync(join(root, "conversations", `${SESSION}.db`), "");
    writeFileSync(join(root, "annotations", `${SESSION}.pbtxt`), "");
    writeFileSync(join(root, "conversations", "other.db"), "");
    const agy = setup({
      onPrompt(_message, fake) {
        fake.update({ sessionUpdate: "tool_call", toolCallId: "call_1", name: "list_dir", kind: "read", status: "completed" });
        return answer("Seen")(_message, fake);
      },
    });
    const session = await open(agy, { ephemeral: true, env: { HOME: dir } });
    expect(session.cwd).toBe("/tmp/project");
    expect((await session.runTurn({ prompt: "Look around" })).text).toBe("Seen");
    await session.close();
    expect(readdirSync(join(root, "conversations"))).toEqual(["other.db"]);
    expect(existsSync(join(root, "brain", SESSION))).toBe(false);
    expect(existsSync(join(root, "annotations", `${SESSION}.pbtxt`))).toBe(false);
  });

  it("delete the files of the subagents the session launched, and theirs", async () => {
    const dir = home();
    const root = join(dir, ".gemini", "antigravity-cli");
    mkdirSync(join(root, "conversations"), { recursive: true });
    for (const id of [SESSION, "child-1", "grandchild-1", "other"]) {
      mkdirSync(join(root, "brain", id), { recursive: true });
      writeFileSync(join(root, "conversations", `${id}.db`), "");
    }
    writeSubagent(root, SESSION, "child-1");
    writeSubagent(root, "child-1", "grandchild-1");
    const session = await open(setup(), { ephemeral: true, env: { HOME: dir } });
    await session.close();
    expect(readdirSync(join(root, "conversations"))).toEqual(["other.db"]);
    expect(readdirSync(join(root, "brain"))).toEqual(["other"]);
  });

  it("delete every subagent's files, however many the session launched", async () => {
    const dir = home();
    const root = join(dir, ".gemini", "antigravity-cli");
    mkdirSync(join(root, "conversations"), { recursive: true });
    const children = Array.from({ length: 300 }, (_, index) => `child-${index}`);
    for (const id of [SESSION, ...children]) writeFileSync(join(root, "conversations", `${id}.db`), "");
    for (const child of children) writeSubagent(root, SESSION, child);
    const session = await open(setup(), { ephemeral: true, env: { HOME: dir } });
    await session.close();
    expect(readdirSync(join(root, "conversations"))).toEqual([]);
  });

  it("delete the session's files when opening fails after agy created it", async () => {
    const dir = home();
    const root = join(dir, ".gemini", "antigravity-cli");
    mkdirSync(join(root, "conversations"), { recursive: true });
    writeFileSync(join(root, "conversations", `${SESSION}.db`), "");
    const agy = setup({
      onRequest(message, fake) {
        if (message.method !== "session/set_config_option") return false;
        fake.fail(message.id, { code: -32603, message: "no" });
        return true;
      },
    });
    await expect(open(agy, { ephemeral: true, model: "claude-sonnet-4-6", env: { HOME: dir } })).rejects.toThrow();
    expect(readdirSync(join(root, "conversations"))).toEqual([]);
  });

  it("cannot resume a session", async () => {
    await expect(open(setup(), { ephemeral: true, resumeSessionId: "s" })).rejects.toThrow();
  });
});

describe("process exit", () => {
  it("rejects the running turn with the stderr tail and fires onClose", async () => {
    const agy = setup();
    const session = await open(agy);
    const closes: Error[] = [];
    session.onClose((error) => closes.push(error));
    const turn = session.runTurn({ prompt: "x" });
    await vi.waitFor(() => expect(agy.prompts()).toHaveLength(1));
    agy.child.stderr.write("panic: agy crashed\n");
    await tick();
    agy.child.emit("close", 2);
    await expect(turn).rejects.toThrow("panic: agy crashed");
    expect(closes).toHaveLength(1);
    expect(session.closed).toBe(true);
  });
});

