import { vi } from "vitest";
import { captureRequests, makeFakeChild, send, type FakeChild, type RpcMessage } from "./fake-child.js";

export const SESSION = "11111111-2222-4333-8444-555555555555";

export function configOptions(values: { model?: string; thought?: string | null; mode?: string } = {}) {
  const model = values.model ?? "gemini-3.8-flash";
  const options: Array<Record<string, unknown>> = [
    {
      id: "model",
      category: "model",
      type: "select",
      currentValue: model,
      options: [
        { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
      ],
    },
  ];
  if (values.thought !== null && model.startsWith("gemini")) {
    options.push({
      id: "thought_level",
      category: "thought_level",
      type: "select",
      currentValue: values.thought ?? "high",
      options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
    });
  }
  options.push({
    id: "mode",
    category: "mode",
    type: "select",
    currentValue: values.mode ?? "default",
    options: [{ value: "default" }, { value: "accept-edits" }, { value: "auto" }, { value: "plan" }],
  });
  return options;
}

export interface FakeAgy {
  child: FakeChild;
  requests: RpcMessage[];
  /** Send a session/update for the session. */
  update(update: Record<string, unknown>, sessionId?: string): void;
  /** Answer a request the session sent. */
  respond(id: RpcMessage["id"], result: unknown): void;
  fail(id: RpcMessage["id"], error: { code: number; message: string }): void;
  /** Ask the session something, as agy's server requests do. */
  ask(id: string, method: string, params: Record<string, unknown>): void;
  prompts(): RpcMessage[];
  spawnFn: never;
}

export interface FakeAgyOptions {
  version?: string;
  appendCapability?: boolean;
  image?: boolean;
  /** Handles session/prompt; without it prompts stay open for the test. */
  onPrompt?: (message: RpcMessage, agy: FakeAgy) => void;
  onRequest?: (message: RpcMessage, agy: FakeAgy) => boolean | void;
  commands?: string[];
}

/** A scripted `agy acp`: answers the handshake, opens sessions and tracks
 * config options the way agy 1.5.13 does. */
export function fakeAgy(options: FakeAgyOptions = {}): FakeAgy {
  const child = makeFakeChild();
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("close", null));
    return true;
  });
  let config = configOptions();
  const agy: FakeAgy = {
    child,
    requests: [],
    update(update, sessionId = SESSION) {
      send(child, { method: "session/update", params: { sessionId, update } });
    },
    respond(id, result) {
      send(child, { id, result });
    },
    fail(id, error) {
      send(child, { id, error });
    },
    ask(id, method, params) {
      send(child, { id, method, params });
    },
    prompts() {
      return agy.requests.filter((message) => message.method === "session/prompt");
    },
    spawnFn: (() => child) as never,
  };
  agy.requests = captureRequests(child, (message) => {
    if (message.method === undefined) return; // a response to our server request
    if (options.onRequest?.(message, agy)) return;
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        agy.respond(message.id, {
          protocolVersion: 1,
          agentInfo: { name: "Antigravity ACP Server", version: options.version ?? "1.5.13" },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: options.image ?? true, audio: false, embeddedContext: true },
            sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} },
            ...(options.appendCapability === false ? {} : { _meta: { antigravity: { systemPrompt: { append: true } } } }),
          },
        });
        return;
      case "authenticate":
        agy.respond(message.id, {});
        return;
      case "session/new":
      case "session/resume":
        agy.respond(message.id, {
          ...(message.method === "session/new" ? { sessionId: SESSION } : {}),
          modes: {
            currentModeId: "default",
            availableModes: [{ id: "default" }, { id: "accept-edits" }, { id: "auto" }, { id: "plan" }],
          },
          configOptions: config,
        });
        agy.update({
          sessionUpdate: "available_commands_update",
          availableCommands: (options.commands ?? ["compact", "plan"]).map((name) => ({ name })),
        });
        return;
      case "session/set_config_option": {
        const current = Object.fromEntries(config.map((option) => [option.id, option.currentValue as string]));
        current[params.configId as string] = params.value as string;
        config = configOptions({
          model: current.model,
          mode: current.mode,
          ...(current.thought_level ? { thought: current.thought_level } : {}),
        });
        agy.respond(message.id, { configOptions: config });
        return;
      }
      case "session/set_mode":
      case "session/close":
        agy.respond(message.id, {});
        return;
      case "session/prompt":
        options.onPrompt?.(message, agy);
        return;
      default:
        return;
    }
  });
  return agy;
}

/** A turn agy answers with prose, a usage update and end_turn. */
export function answer(text: string, used = 100) {
  return (message: RpcMessage, agy: FakeAgy) => {
    agy.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    agy.update({ sessionUpdate: "usage_update", used, size: 1_048_576 });
    agy.respond(message.id, {
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 3, cachedWriteTokens: 0, thoughtTokens: 2, totalTokens: 18 },
    });
  };
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));
