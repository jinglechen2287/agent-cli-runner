/**
 * Long-lived agy sessions on one `agy acp` process. How the session talks to
 * agy follows T3 Code's agy adapter (config options by category, steering
 * with a second prompt, subagent completion read from agy's brain/ files,
 * errors read from its step log); what it promises follows the Claude and
 * Codex sessions in this library.
 */
import { lstat, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { agyRequestError, startAgyAcp, type AgyAgentInfo } from "./agy-client.js";
import { listAgyChildIds, readAgyChildren } from "./agy-children.js";
import {
  agyFinalUsage,
  agyPlanToolUse,
  agyToolResult,
  agyToolUse,
  agyUsage,
  isAgyDaemon,
  isAgySubagentCall,
  isTerminalToolStatus,
  mergeAgyToolCall,
  permissionOptions,
  pickPermissionOption,
  toolOutlivesPrompt,
  type AgyPermissionOption,
  type AgyToolCall,
} from "./agy-items.js";
import { classifyAgyOutcome, loadNodeSqliteStepReader, type AgyStepReader } from "./agy-outcome.js";
import { agyDataRoot, isAgyId, literalPath } from "./agy-paths.js";
import {
  AbortError,
  AgyTurnError,
  runAborted,
  runTimedOut,
  SteerRejectedError,
  TimeoutError,
  UnsupportedServerRequestError,
} from "./errors.js";
import { createDeferred, isRecord, safeCallback, type Deferred } from "./internal.js";
import type { JsonRpcClient } from "./jsonrpc-process.js";
import type {
  AgentCallbacks,
  BackgroundAgentInfo,
  RunResult,
  SpawnFn,
  ToolUseInfo,
} from "./types.js";
import type { TokenUsage } from "./usage.js";

/** How long a cancelled prompt may take to answer before the process is
 * stopped (T3 Code's wait). */
export const AGY_INTERRUPT_GRACE_MS = 15_000;
const OPEN_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 2_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ISOLATED_MAX_OUTPUT_CHARS = 128_000;
/** How long a held turn or continuation waits, after agy's usage update closes
 * a reply, before deciding it ended: agy sends a usage update mid-reply too.
 * T3 Code's ACP_DEFERRED_FINALIZE_DEBOUNCE. */
const REPLY_QUIET_MS = 3_000;
/** The same wait while a reply is still open, so a reply that never closes
 * cannot hold forever. T3 Code's ACP_OPEN_REPLY_QUIET_LIMIT. */
const OPEN_REPLY_QUIET_MS = 120_000;
/** How often a held turn checks for subagents agy left no record of. */
const HOLD_CHECK_MS = 30_000;
/** A subagent still missing from agy's files this long after its launch is
 * given up on, so a changed file layout cannot hold a turn forever. */
const LOST_AGENT_MS = 120_000;
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".bmp": "image/bmp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** An agy execution mode, checked against the modes the session advertises
 * (agy 1.5.13: default, accept-edits, auto, plan). */
export type AgyMode = string;

/** An MCP server for the session, in this library's shape. */
export type AgyMcpServer =
  | { type?: "stdio"; name: string; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; name: string; url: string; headers?: Record<string, string> };

export interface AgyPermissionRequest {
  /** `question`: agy's own question to the user (an `interaction_` call). */
  kind: "approval" | "question";
  toolCall: ToolUseInfo;
  options: Array<{ id: string; name: string; kind: string }>;
}

/** An option id from the request, or "cancel". */
export type AgyPermissionAnswer = string;

export type AgyPermissionCallback = (
  request: AgyPermissionRequest,
  context: { signal: AbortSignal },
) => Promise<AgyPermissionAnswer>;

/** Callbacks for output agy produces while no turn is open. */
export interface AgyContinuationHandlers extends AgentCallbacks {
  onPermissionRequest?: AgyPermissionCallback;
  /** The continuation ended: its reply finished, or a new turn took over. */
  onEnd?: (outcome: { result?: RunResult; error?: Error }) => void;
}

export interface CreateAgySessionOptions {
  cwd: string;
  executablePath?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
  /** Gives up on opening the session. */
  signal?: AbortSignal;
  geminiDir?: string;
  appDataDir?: string;
  authMethod?: string;
  resumeSessionId?: string;
  /** The model for every turn that doesn't name its own; "default" keeps
   * agy's current one. */
  model?: string;
  effort?: string;
  mode?: AgyMode;
  appendSystemPrompt?: string;
  mcpServers?: AgyMcpServer[];
  /** Answer every approval agy asks for with "allow once", and start agy
   * with `--dangerously-skip-permissions`, since a subagent's approvals never
   * reach the host and would otherwise hold its turn forever. */
  dangerouslySkipPermissions?: boolean;
  /** A one-off metadata run: a fresh temp cwd, no tools, nothing left behind. */
  isolated?: boolean;
  /** A throwaway session in `cwd`, tools and all, whose conversation, brain
   * and annotation files are deleted when it closes: a side run that leaves
   * no conversation behind. It cannot resume a session. */
  ephemeral?: boolean;
  /** Output agy produces while no turn is open (a finished daemon, a late
   * wake). Without it that output is dropped. */
  onContinuation?: (start: { reason: "output" | "permission" }) => AgyContinuationHandlers | undefined;
  interruptGraceMs?: number;
  /** How long a turn held for background work waits after agy's reply
   * closes before ending. Default 3 s. */
  replyQuietMs?: number;
  /** End a turn this long after agy answered when only commands it left
   * running hold it, so a stray long command can't keep the turn open. What
   * agy says once they finish goes to `onContinuation`, or is dropped.
   * Running subagents still hold the turn. Off unless given. */
  commandHoldMs?: number;
  /** Fail a turn that sees no update for this long while nothing it waits on
   * is open. Off unless given. */
  inactivityTimeoutMs?: number;
  /** Test seam: replaces the node:sqlite step reader; null reads no step
   * log, as on a runtime without node:sqlite. */
  stepReader?: AgyStepReader | null;
}

export type AgyTurnOptions = AgentCallbacks & {
  prompt: string;
  imagePaths?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  model?: string;
  effort?: string;
  mode?: AgyMode;
  onPermissionRequest?: AgyPermissionCallback;
};

export type AgyCompactOptions = AgentCallbacks & {
  instructions?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export interface AgySession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly closed: boolean;
  /** Where turn errors come from: agy's step log, or the stop reason alone
   * on a runtime without node:sqlite. */
  readonly outcomeSource: "steps-db" | "stop-reason";
  runTurn(options: AgyTurnOptions): Promise<RunResult>;
  /** Hand more input to the running turn. Rejects with SteerRejectedError
   * when no prompt of a turn is outstanding. */
  steer(options: { prompt: string }): Promise<void>;
  /** Compact the conversation with agy's `/compact`, as a turn of its own. */
  compact(options: AgyCompactOptions): Promise<RunResult>;
  onClose(handler: (error: Error) => void): () => void;
  close(): Promise<void>;
}

interface ConfigOption {
  id: string;
  category?: string;
  currentValue?: string;
  values: Array<{ value: string; name?: string }>;
}

function parseConfigOptions(value: unknown): ConfigOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord).flatMap((option) => {
    if (typeof option.id !== "string") return [];
    const values = Array.isArray(option.options)
      ? option.options.filter(isRecord).flatMap((choice) => typeof choice.value === "string"
        ? [{ value: choice.value, ...(typeof choice.name === "string" ? { name: choice.name } : {}) }]
        : [])
      : [];
    return [{
      id: option.id,
      ...(typeof option.category === "string" ? { category: option.category } : {}),
      ...(typeof option.currentValue === "string" ? { currentValue: option.currentValue } : {}),
      values,
    }];
  });
}

function findOption(options: readonly ConfigOption[], category: string): ConfigOption | undefined {
  return options.find((option) => option.category === category)
    ?? options.find((option) => option.id === category);
}

function acpMcpServers(servers: readonly AgyMcpServer[]): Array<Record<string, unknown>> {
  const pairs = (record: Record<string, string> | undefined) =>
    Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));
  return servers.map((server) => {
    if ("url" in server) {
      return { type: server.type, name: server.name, url: server.url, headers: pairs(server.headers) };
    }
    return { name: server.name, command: server.command, args: server.args ?? [], env: pairs(server.env) };
  });
}

/** Delete one agy session's own files under its data root. Only for a
 * session id this process created. */
export async function removeAgySessionFiles(root: string, sessionId: string, removed = new Set<string>()): Promise<void> {
  if (!isAgyId(sessionId) || removed.has(sessionId)) return;
  removed.add(sessionId);
  // A subagent is a conversation of its own: its files go too, read from the
  // parent's records before those go with the parent's brain.
  for (const child of await listAgyChildIds(root, sessionId)) await removeAgySessionFiles(root, child, removed);
  const remove = async (segments: string[], recursive = false) => {
    const path = join(root, ...segments);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      await rm(path, { recursive, force: true });
    } catch {
      // Already gone, or never written.
    }
  };
  for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"]) {
    await remove(["conversations", `${sessionId}${suffix}`]);
  }
  await remove(["brain", sessionId], true);
  await remove(["annotations", `${sessionId}.pbtxt`]);
}

/** Whether an isolated run's temp cwd holds only what agy itself creates:
 * empty `.agents/skills` and `.gemini/skills` folders. */
async function workspaceUntouched(cwd: string): Promise<boolean> {
  const allowed: Readonly<Record<string, string>> = { ".agents": "skills", ".gemini": "skills" };
  try {
    for (const name of await readdir(cwd)) {
      const inner = allowed[name];
      if (!inner) return false;
      const entries = await readdir(join(cwd, name));
      if (entries.some((entry) => entry !== inner)) return false;
      if (entries.length && (await readdir(join(cwd, name, inner))).length > 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function imageBlock(path: string): Promise<Record<string, unknown>> {
  const mimeType = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!mimeType) {
    throw new AgyTurnError(`agy takes bmp, jpeg, png or webp images, not ${path}`, {
      kind: "invalid_request",
      code: "unsupported_image",
    });
  }
  const info = await stat(path);
  if (!info.isFile()) {
    throw new AgyTurnError(`Image ${path} is not a file`, { kind: "invalid_request", code: "unsupported_image" });
  }
  if (info.size > MAX_IMAGE_BYTES) {
    throw new AgyTurnError(`Image ${path} is larger than 10 MiB`, { kind: "invalid_request", code: "image_too_large" });
  }
  return { type: "image", mimeType, data: (await readFile(path)).toString("base64") };
}

type RunKind = "turn" | "compact" | "continuation";

interface Run {
  kind: RunKind;
  callbacks: AgentCallbacks & { onPermissionRequest?: AgyPermissionCallback };
  onEnd?: AgyContinuationHandlers["onEnd"];
  done: Deferred<RunResult>;
  outstanding: number;
  lastResponse?: Record<string, unknown>;
  promptError?: Error;
  buffer: string;
  lastMessage: string;
  outputChars: number;
  toolUses: Set<string>;
  toolResults: Set<string>;
  openTools: Set<string>;
  /** Subagents this run started. */
  agents: Set<string>;
  holding: boolean;
  /** Every prompt has answered: what agy sends now are replies of its own. */
  answered: boolean;
  /** agy has sent output since its last usage update. */
  replyOpen: boolean;
  /** agy has sent output of its own since every prompt answered. */
  repliedSinceAnswer: boolean;
  cancelRequested: boolean;
  interruption?: Error;
  usage?: TokenUsage;
  usedBefore?: number;
  compactionReported: boolean;
  stepIndex?: number;
  /** Fires when the run ends, telling permission callbacks to stop. */
  ended: AbortController;
  steers: Array<Deferred<void>>;
}

interface AgentEntry {
  info: BackgroundAgentInfo;
  /** The run that started it: told about it when no other run is open. */
  owner: Run;
  /** Whether agy's files have shown this subagent. */
  seen: boolean;
}

export async function createAgySession(options: CreateAgySessionOptions): Promise<AgySession> {
  if (options.commandHoldMs !== undefined && !(Number.isFinite(options.commandHoldMs) && options.commandHoldMs > 0)) {
    throw new Error("commandHoldMs must be a positive number of milliseconds");
  }
  if (options.ephemeral && options.resumeSessionId) throw new Error("ephemeral agy sessions cannot resume a session");
  if (options.isolated) {
    if (options.resumeSessionId) throw new Error("isolated agy runs cannot resume a session");
    if (options.mcpServers?.length) throw new Error("isolated agy runs cannot take MCP servers");
    if (options.mode !== undefined) throw new Error("isolated agy runs cannot set a mode");
    if (options.dangerouslySkipPermissions) throw new Error("isolated agy runs cannot skip permissions");
  }
  const cwd = options.isolated ? await mkdtemp(join(tmpdir(), "agent-cli-runner-agy-")) : options.cwd;
  const removeTempCwd = async () => {
    if (options.isolated) await rm(cwd, { recursive: true, force: true }).catch(() => {});
  };
  const env = options.env ?? process.env;
  const root = agyDataRoot({ geminiDir: options.geminiDir, appDataDir: options.appDataDir, env });

  let started: Awaited<ReturnType<typeof startAgyAcp>>;
  try {
    started = await startAgyAcp({
      cwd,
      env,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.geminiDir ? { geminiDir: options.geminiDir } : {}),
      ...(options.appDataDir ? { appDataDir: options.appDataDir } : {}),
      ...(options.authMethod ? { authMethod: options.authMethod } : {}),
      ...(options.dangerouslySkipPermissions ? { skipPermissions: true } : {}),
    });
  } catch (error) {
    await removeTempCwd();
    throw error;
  }
  const { client, whenExited, agent } = started;
  // The signal covers the whole open: closing the client rejects whatever
  // request (session/new, a setting) is still pending.
  const abort = () => client.close();
  options.signal?.addEventListener("abort", abort, { once: true });
  let openedId: string | undefined;
  try {
    if (options.signal?.aborted) throw new AbortError();
    return await openSession({
      options, cwd, root, client, whenExited, agent, removeTempCwd,
      onOpened: (id) => { openedId = id; },
    });
  } catch (error) {
    client.close();
    if ((options.isolated || options.ephemeral) && openedId) {
      await whenExited;
      await removeAgySessionFiles(root, openedId);
    }
    await removeTempCwd();
    throw options.signal?.aborted ? new AbortError() : error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

interface OpenContext {
  options: CreateAgySessionOptions;
  cwd: string;
  root: string;
  client: JsonRpcClient;
  whenExited: Promise<void>;
  agent: AgyAgentInfo;
  removeTempCwd: () => Promise<void>;
  /** agy has created the session: its files are there from here on. */
  onOpened: (sessionId: string) => void;
}

function appendCapability(agent: AgyAgentInfo): boolean {
  const meta = isRecord(agent.capabilities._meta) ? agent.capabilities._meta : undefined;
  const antigravity = meta && isRecord(meta.antigravity) ? meta.antigravity : undefined;
  const systemPrompt = antigravity && isRecord(antigravity.systemPrompt) ? antigravity.systemPrompt : undefined;
  return systemPrompt?.append === true;
}

function capability(agent: AgyAgentInfo, group: string, name: string): boolean {
  const section = agent.capabilities[group];
  return isRecord(section) && (section[name] === true || isRecord(section[name]));
}

async function openSession(context: OpenContext): Promise<AgySession> {
  const { options, cwd, root, client, whenExited, agent } = context;
  const isolated = options.isolated === true;
  const stepReader: AgyStepReader | undefined = options.stepReader === null
    ? undefined
    : options.stepReader ?? await loadNodeSqliteStepReader();
  const interruptGraceMs = options.interruptGraceMs ?? AGY_INTERRUPT_GRACE_MS;
  const replyQuietMs = options.replyQuietMs ?? REPLY_QUIET_MS;
  const appendViaMeta = appendCapability(agent);

  let sessionId = options.resumeSessionId ?? "";
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let configOptions: ConfigOption[] = [];
  let currentMode: string | undefined;
  let availableModes: string[] = [];
  const sentValues = new Map<string, string>();
  const availableCommands = new Set<string>();
  const toolCalls = new Map<string, AgyToolCall>();
  const agents = new Map<string, AgentEntry>();
  /** Subagents that ended in a finished run: their entries are dropped, the
   * ids kept so a late update cannot start them again. */
  const endedAgents = new Set<string>();
  let lastUsage: TokenUsage | undefined;
  let run: Run | undefined;
  /** After our cancel, agy's trailing output up to the next prompt is dropped. */
  let quietUntilPrompt = false;
  let pendingPermissions = 0;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let replyTimer: ReturnType<typeof setTimeout> | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let commandHoldTimer: ReturnType<typeof setTimeout> | undefined;

  const currentModel = (): string | undefined => {
    const option = findOption(configOptions, "model");
    return sentValues.get(option?.id ?? "model") ?? option?.currentValue;
  };

  const applyConfig = (value: unknown): void => {
    const parsed = parseConfigOptions(value);
    if (!parsed) return;
    configOptions = parsed;
    // agy may report a family id for a legacy id it was sent: keep the sent
    // value only while agy still reports it, or its family.
    for (const [id, sent] of sentValues) {
      const reported = parsed.find((option) => option.id === id)?.currentValue;
      if (reported && reported !== sent && !sent.startsWith(`${reported}-`)) sentValues.delete(id);
    }
    const modeOption = findOption(parsed, "mode");
    if (modeOption?.currentValue) currentMode = modeOption.currentValue;
    if (modeOption && availableModes.length === 0) availableModes = modeOption.values.map((choice) => choice.value);
  };

  const applyModes = (value: unknown): void => {
    if (!isRecord(value)) return;
    if (typeof value.currentModeId === "string") currentMode = value.currentModeId;
    if (Array.isArray(value.availableModes)) {
      availableModes = value.availableModes.filter(isRecord)
        .flatMap((mode) => typeof mode.id === "string" ? [mode.id] : []);
    }
  };

  // --- running work ------------------------------------------------------

  const runningAgents = (owner?: Run): AgentEntry[] => [...agents.values()].filter((entry) =>
    entry.info.status === "running" && (owner ? owner.agents.has(entry.info.id) : true));

  const emitAgent = (entry: AgentEntry): void => {
    const snapshot = { ...entry.info };
    const target = run ?? entry.owner;
    safeCallback(() => target.callbacks.onBackgroundAgentUpdate?.(snapshot));
  };

  const refreshAgents = async (): Promise<void> => {
    const ids = runningAgents().map((entry) => entry.info.id);
    if (ids.length === 0 || !sessionId) return;
    const children = await readAgyChildren(root, sessionId, ids);
    const now = Date.now();
    for (const [toolCallId, child] of children) {
      const entry = agents.get(toolCallId);
      if (!entry || entry.info.status !== "running") continue;
      entry.seen = true;
      if (child.state === "running") continue;
      entry.info = {
        ...entry.info,
        status: child.state === "killed" ? "interrupted" : "completed",
        ...(child.summary ? { summary: child.summary } : {}),
        updatedAt: now,
        endedAt: child.reportedAt ?? now,
      };
      emitAgent(entry);
    }
  };

  const interruptAgents = (): void => {
    const now = Date.now();
    for (const entry of runningAgents()) {
      entry.info = { ...entry.info, status: "interrupted", updatedAt: now, endedAt: now };
      emitAgent(entry);
    }
  };

  const heldTools = (target: Run): boolean => [...target.openTools].some((id) => {
    const call = toolCalls.get(id);
    return call !== undefined && toolOutlivesPrompt(call);
  });

  /** Open tool calls other than daemons, which run on past every turn. */
  const waitedTools = (target: Run): number => [...target.openTools].filter((id) => {
    const call = toolCalls.get(id);
    return call === undefined || !isAgyDaemon(call);
  }).length;

  const backgroundOutstanding = (target: Run): boolean =>
    runningAgents(target).length > 0 || heldTools(target);

  const flush = (target: Run): void => {
    if (!target.buffer.trim()) {
      target.buffer = "";
      return;
    }
    const message = target.buffer;
    target.buffer = "";
    target.lastMessage = message;
    safeCallback(() => target.callbacks.onAssistantText?.(message));
  };

  const result = (target: Run): RunResult => {
    const usage = agyFinalUsage(target.usage ?? lastUsage, target.lastResponse?.usage, currentModel());
    return {
      text: target.kind === "compact" ? "" : target.lastMessage,
      exitCode: 0,
      sessionId,
      ...(usage ? { usage } : {}),
    };
  };

  const clearInactivity = (): void => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = undefined;
  };

  const clearReplyTimer = (): void => {
    if (replyTimer) clearTimeout(replyTimer);
    replyTimer = undefined;
  };

  const finish = (target: Run, outcome: { result?: RunResult; error?: Error }): void => {
    if (target.done.settled) return;
    if (run === target) {
      run = undefined;
      clearInactivity();
      clearReplyTimer();
    }
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = undefined;
    if (commandHoldTimer) clearTimeout(commandHoldTimer);
    commandHoldTimer = undefined;
    for (const id of target.agents) {
      if (agents.get(id)?.info.status === "running") continue;
      agents.delete(id);
      endedAgents.add(id);
    }
    target.ended.abort();
    for (const steer of target.steers.splice(0)) {
      steer.reject(new SteerRejectedError("The agy turn ended before taking the steer"));
    }
    if (outcome.result) {
      const usage = outcome.result.usage;
      if (usage) safeCallback(() => target.callbacks.onUsage?.(usage));
      target.done.resolve(outcome.result);
    } else {
      target.done.reject(outcome.error ?? new Error("agy turn ended"));
    }
    if (target.kind === "continuation") safeCallback(() => target.onEnd?.(outcome));
  };

  const armInactivity = (): void => {
    clearInactivity();
    const limit = options.inactivityTimeoutMs;
    const target = run;
    if (limit === undefined || !target) return;
    inactivityTimer = setTimeout(() => {
      if (run !== target) return;
      // A pending reply-end check decides how a quiet reply ends.
      const paused = pendingPermissions > 0 || waitedTools(target) > 0 || runningAgents(target).length > 0
        || replyTimer !== undefined;
      if (paused) {
        armInactivity();
        return;
      }
      const error = new TimeoutError(`agy sent nothing for ${limit}ms`);
      finish(target, { error });
      void closeWith(error);
    }, limit);
    inactivityTimer.unref?.();
  };

  const settleSuccess = async (target: Run): Promise<void> => {
    flush(target);
    if (isolated && !(await workspaceUntouched(cwd))) {
      finish(target, { error: new AgyTurnError("The isolated agy run changed its workspace", { code: "workspace_modified" }) });
      return;
    }
    if (target.kind === "compact") {
      const after = (target.usage ?? lastUsage)?.contextTokens;
      if (!target.compactionReported && target.usedBefore !== undefined && after !== undefined && after < target.usedBefore) {
        target.compactionReported = true;
        safeCallback(() => target.callbacks.onCompaction?.({
          trigger: "manual",
          preTokens: target.usedBefore!,
          postTokens: after,
        }));
      }
    }
    finish(target, { result: result(target) });
  };

  /** A reply agy sent by itself ended: check the background work again. */
  const replyEnded = async (target: Run): Promise<void> => {
    flush(target);
    await refreshAgents();
    if (target.done.settled) return;
    if (target.kind === "continuation") {
      if (!backgroundOutstanding(target)) finish(target, { result: result(target) });
      return;
    }
    if (target.holding && !backgroundOutstanding(target)) await settleSuccess(target);
  };

  /** agy never says a reply it sent by itself is over: wait for quiet, and
   * start the wait again on every update. */
  const armReplyEnd = (target: Run, replyOpen: boolean): void => {
    clearReplyTimer();
    replyTimer = setTimeout(() => {
      replyTimer = undefined;
      if (run === target) void replyEnded(target);
    }, replyOpen ? OPEN_REPLY_QUIET_MS : replyQuietMs);
    replyTimer.unref?.();
  };

  /** Give up on subagents agy's files still don't show long after their
   * launch, then end the hold if nothing else keeps it. */
  const dropLostAgents = async (target: Run): Promise<void> => {
    const now = Date.now();
    const missing = runningAgents(target).filter((entry) => !entry.seen && now - entry.info.startedAt >= LOST_AGENT_MS);
    if (missing.length === 0 || !sessionId) return;
    const children = await readAgyChildren(root, sessionId, missing.map((entry) => entry.info.id));
    let dropped = false;
    for (const entry of missing) {
      if (children.has(entry.info.id)) {
        entry.seen = true;
        continue;
      }
      if (entry.info.status !== "running") continue;
      entry.info = {
        ...entry.info,
        status: "failed",
        error: "agy left no record of this subagent",
        updatedAt: now,
        endedAt: now,
      };
      emitAgent(entry);
      dropped = true;
    }
    // While a reply is coming in, its end decides instead.
    if (dropped && !replyTimer) await replyEnded(target);
  };

  const armHoldCheck = (target: Run): void => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      if (run !== target || target.done.settled) return;
      armHoldCheck(target);
      void dropLostAgents(target);
    }, HOLD_CHECK_MS);
    holdTimer.unref?.();
  };

  /** Stop waiting on commands agy left running once `commandHoldMs` has
   * passed. Subagents report back, and a reply agy is sending or a question
   * it is asking is still the turn's, so while any is under way the wait
   * starts over; once nothing but commands holds the turn, it ends. */
  const armCommandHold = (target: Run): void => {
    const limit = options.commandHoldMs;
    if (limit === undefined) return;
    if (commandHoldTimer) clearTimeout(commandHoldTimer);
    commandHoldTimer = setTimeout(() => {
      commandHoldTimer = undefined;
      if (run !== target || target.done.settled || !target.holding) return;
      const replying = target.repliedSinceAnswer && (target.replyOpen || replyTimer !== undefined);
      // Something else holds the turn, or nothing does yet: wait again, since a reply to a subagent can still leave a command running after it.
      if (!heldTools(target) || runningAgents(target).length > 0 || replying || pendingPermissions > 0) {
        armCommandHold(target);
        return;
      }
      void settleSuccess(target);
    }, limit);
    commandHoldTimer.unref?.();
  };

  const dbPath = (): string | undefined =>
    isAgyId(sessionId) ? join(root, "conversations", `${sessionId}.db`) : undefined;

  const recordStepIndex = async (target: Run): Promise<void> => {
    const path = dbPath();
    if (!stepReader || !path) return;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
    } catch {
      target.stepIndex = -1; // the prompt creates the log
      return;
    }
    const index = stepReader.lastIndex(path);
    if (index !== undefined) target.stepIndex = index;
  };

  const outcomeError = async (target: Run, stopReason: string): Promise<AgyTurnError | undefined> => {
    let step;
    if (stepReader && target.stepIndex !== undefined) {
      const path = await literalPath(root, ["conversations", `${sessionId}.db`]);
      step = path ? stepReader.lastStepAfter(path, target.stepIndex) : undefined;
    }
    const failure = classifyAgyOutcome(stopReason, step, new Date());
    if (!failure) return undefined;
    return new AgyTurnError(failure.message, {
      kind: failure.kind,
      retryable: failure.retryable,
      broken: failure.broken,
      ...(failure.code !== undefined ? { code: failure.code } : {}),
      ...(failure.resetAt !== undefined ? { resetAt: failure.resetAt } : {}),
      ...(failure.stopReason !== undefined ? { stopReason: failure.stopReason } : {}),
      ...(target.lastMessage ? { text: target.lastMessage } : {}),
    });
  };

  /** Every prompt of the run has answered: decide how the run ends. */
  const promptsAnswered = async (target: Run): Promise<void> => {
    if (target.done.settled) return;
    flush(target);
    if (target.cancelRequested) {
      finish(target, { error: target.interruption ?? runAborted("agy") });
      return;
    }
    const response = target.lastResponse;
    if (!response) {
      finish(target, { error: target.promptError ?? new AgyTurnError("agy answered no prompt") });
      return;
    }
    const stopReason = typeof response.stopReason === "string" ? response.stopReason : "";
    if (stopReason === "end_turn" || stopReason === "refusal") {
      const failure = await outcomeError(target, stopReason);
      if (target.done.settled) return;
      if (failure) {
        finish(target, { error: failure });
        if (failure.broken) void closeWith(failure);
        return;
      }
      if (stopReason === "refusal") {
        finish(target, { error: new AgyTurnError("agy refused the turn", { stopReason, ...(target.lastMessage ? { text: target.lastMessage } : {}) }) });
        return;
      }
      await refreshAgents();
      if (target.done.settled) return;
      if (target.kind !== "compact" && backgroundOutstanding(target)) {
        target.holding = true;
        armInactivity();
        armHoldCheck(target);
        armCommandHold(target);
        // A reply agy sent while this read its files has no check left to
        // end the hold once its quiet time ran out: start one.
        if (target.repliedSinceAnswer && !replyTimer) armReplyEnd(target, target.replyOpen);
        return;
      }
      await settleSuccess(target);
      return;
    }
    finish(target, {
      error: new AgyTurnError(
        stopReason === "cancelled" ? "agy cancelled the turn" : `agy stopped the turn: ${stopReason || "no stop reason"}`,
        { stopReason, ...(target.lastMessage ? { text: target.lastMessage } : {}) },
      ),
    });
  };

  const sendPrompt = (target: Run, blocks: Array<Record<string, unknown>>, steer?: Deferred<void>): void => {
    target.outstanding += 1;
    quietUntilPrompt = false;
    const previous = target.outstanding > 1;
    client.request("session/prompt", { sessionId, prompt: blocks }, null).then(
      (response) => {
        target.outstanding -= 1;
        if (isRecord(response)) target.lastResponse = response;
        if (steer && !steer.settled) steer.resolve();
        // The earlier prompt answering means agy took the steer.
        if (!steer) for (const pending of target.steers.splice(0)) pending.resolve();
        if (target.outstanding === 0) {
          target.answered = true;
          void promptsAnswered(target);
        }
      },
      (error: unknown) => {
        target.outstanding -= 1;
        const failure = agyRequestError(error, "agy prompt failed");
        if (steer) {
          if (!steer.settled) steer.reject(new SteerRejectedError(failure.message));
        } else {
          target.promptError = failure;
        }
        if (target.outstanding === 0) {
          target.answered = true;
          void promptsAnswered(target);
        }
      },
    );
    if (steer && previous) target.steers.push(steer);
  };

  const closeWith = async (reason: Error): Promise<void> => {
    if (run) finish(run, { error: reason });
    await close();
  };

  // --- incoming updates --------------------------------------------------

  const startContinuation = (reason: "output" | "permission"): Run | undefined => {
    if (quietUntilPrompt || closed || !options.onContinuation) return undefined;
    let handlers: AgyContinuationHandlers | undefined;
    try {
      handlers = options.onContinuation({ reason });
    } catch {
      handlers = undefined;
    }
    if (!handlers) return undefined;
    const continuation = newRun("continuation", handlers);
    continuation.onEnd = handlers.onEnd;
    continuation.done.promise.catch(() => {});
    run = continuation;
    return continuation;
  };

  const isOutput = (kind: string): boolean =>
    kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "tool_call"
    || kind === "tool_call_update" || kind === "plan";

  const handleToolUpdate = (target: Run | undefined, update: Record<string, unknown>): void => {
    const id = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    if (!id) return;
    const merged = mergeAgyToolCall(toolCalls.get(id), update);
    if (!merged) return;
    toolCalls.set(id, merged);
    if (!target) return;
    if (!target.toolUses.has(id)) {
      target.toolUses.add(id);
      flush(target);
      if (isolated) {
        client.notify("session/cancel", { sessionId });
        target.cancelRequested = true;
        target.interruption = new AgyTurnError("The isolated agy run tried to use a tool", { code: "tool_used" });
        finish(target, { error: target.interruption });
        return;
      }
      safeCallback(() => target.callbacks.onToolUse?.(agyToolUse(merged)));
      // A launch first seen already failed started no subagent.
      if (isAgySubagentCall(merged) && !agents.has(id) && !endedAgents.has(id) && merged.status !== "failed") {
        const values = merged.rawInput ?? merged.args ?? {};
        const now = Date.now();
        const entry: AgentEntry = {
          owner: target,
          seen: false,
          info: {
            id,
            provider: "agy",
            parentToolCallId: id,
            ...(typeof values.Role === "string" ? { description: values.Role } : {}),
            ...(typeof values.TypeName === "string" ? { agentType: values.TypeName } : {}),
            status: "running",
            startedAt: now,
            updatedAt: now,
          },
        };
        agents.set(id, entry);
        target.agents.add(id);
        emitAgent(entry);
      }
    }
    if (isTerminalToolStatus(merged.status)) {
      target.openTools.delete(id);
      const agent = agents.get(id);
      if (merged.status === "failed" && agent?.info.status === "running") {
        // The launch failed, so no subagent will ever report back.
        const now = Date.now();
        agent.info = { ...agent.info, status: "failed", updatedAt: now, endedAt: now };
        emitAgent(agent);
      }
      if (!target.toolResults.has(id)) {
        const resultInfo = agyToolResult(merged);
        if (resultInfo) {
          target.toolResults.add(id);
          safeCallback(() => target.callbacks.onToolResult?.(resultInfo));
        }
      }
      // Reported in full: keep no copy of its output for the session's life.
      toolCalls.delete(id);
    } else {
      target.openTools.add(id);
    }
  };

  const handleUpdate = (update: Record<string, unknown>): void => {
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    switch (kind) {
      case "config_option_update":
        applyConfig(update.configOptions);
        return;
      case "current_mode_update":
        if (typeof update.currentModeId === "string") currentMode = update.currentModeId;
        return;
      case "available_commands_update":
        if (Array.isArray(update.availableCommands)) {
          availableCommands.clear();
          for (const command of update.availableCommands) {
            if (isRecord(command) && typeof command.name === "string") availableCommands.add(command.name);
          }
        }
        return;
      case "session_info_update":
      case "user_message_chunk":
        return;
      default:
        break;
    }

    let target = run;
    if (!target && isOutput(kind)) target = startContinuation("output");
    if (target) armInactivity();
    if (target && isOutput(kind)) {
      target.replyOpen = true;
      if (target.answered) target.repliedSinceAnswer = true;
    }
    if (target && kind === "usage_update") target.replyOpen = false;
    if (target && (target.answered || target.kind === "continuation") && (isOutput(kind) || kind === "usage_update")) {
      // A usage update closes the reply unless a tool is still running.
      armReplyEnd(target, kind !== "usage_update" || waitedTools(target) > 0);
    }

    switch (kind) {
      case "agent_message_chunk": {
        const content = isRecord(update.content) ? update.content : undefined;
        const text = typeof content?.text === "string" ? content.text : "";
        if (!target || !text) return;
        target.buffer += text;
        target.outputChars += text.length;
        if (isolated && target.outputChars > ISOLATED_MAX_OUTPUT_CHARS) {
          client.notify("session/cancel", { sessionId });
          target.cancelRequested = true;
          target.interruption = new AgyTurnError("The isolated agy run wrote too much", { code: "output_too_large" });
          finish(target, { error: target.interruption });
          return;
        }
        const delta = text;
        safeCallback(() => target.callbacks.onAssistantTextDelta?.(delta));
        return;
      }
      case "agent_thought_chunk":
        if (target?.buffer.trim()) flush(target);
        return;
      case "tool_call":
      case "tool_call_update":
        handleToolUpdate(target, update);
        return;
      case "plan": {
        const plan = target && sessionId ? agyPlanToolUse(sessionId, update) : undefined;
        if (target && plan) safeCallback(() => target.callbacks.onToolUse?.(plan));
        return;
      }
      case "usage_update": {
        lastUsage = agyUsage(update, currentModel());
        if (!target) return;
        target.usage = lastUsage;
        const usage = lastUsage;
        // A reply agy sends by itself ends at its usage update: its text is
        // one message, whatever the quiet time then decides about the run.
        if (target.answered || target.kind === "continuation") flush(target);
        safeCallback(() => target.callbacks.onUsage?.(usage));
        return;
      }
      case "compaction_update": {
        if (!target || update.status !== "completed" || target.compactionReported) return;
        if (target.kind === "compact") target.compactionReported = true;
        safeCallback(() => target.callbacks.onCompaction?.({ trigger: target.kind === "compact" ? "manual" : "auto" }));
        return;
      }
      default:
        return;
    }
  };

  client.onNotification((method, params) => {
    if (method !== "session/update" || !isRecord(params)) return;
    if (sessionId && params.sessionId !== sessionId) return;
    if (isRecord(params.update)) handleUpdate(params.update);
  });

  const cancelled = { outcome: { outcome: "cancelled" } } as const;
  const selected = (optionId: string) => ({ outcome: { outcome: "selected", optionId } });

  client.onServerRequest(async (request) => {
    if (request.method !== "session/request_permission") {
      throw new UnsupportedServerRequestError(request.method);
    }
    const params = isRecord(request.params) ? request.params : {};
    if (params.sessionId !== sessionId || isolated) return cancelled;
    const choices: AgyPermissionOption[] = permissionOptions(params.options);
    const update = isRecord(params.toolCall) ? params.toolCall : {};
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
    const merged = mergeAgyToolCall(toolCalls.get(toolCallId), update);
    if (merged) toolCalls.set(toolCallId, merged);
    const kind: AgyPermissionRequest["kind"] = toolCallId.startsWith("interaction_") ? "question" : "approval";
    const reject = (): unknown => {
      if (kind === "question") return cancelled;
      const id = pickPermissionOption(choices, "reject_once");
      return id ? selected(id) : cancelled;
    };

    if (kind === "approval" && options.dangerouslySkipPermissions) {
      const id = choices.find((choice) => choice.kind === "allow_once")?.optionId;
      return id ? selected(id) : cancelled;
    }
    const target = run ?? startContinuation("permission");
    // Nobody is there to answer a request that arrives between turns.
    if (!target) return cancelled;
    const callback = target.callbacks.onPermissionRequest;
    if (!callback || !merged) return reject();

    pendingPermissions += 1;
    const answered = new AbortController();
    const fire = () => answered.abort();
    target.ended.signal.addEventListener("abort", fire, { once: true });
    try {
      const answer = await new Promise<string | undefined>((resolve) => {
        answered.signal.addEventListener("abort", () => resolve(undefined), { once: true });
        if (target.ended.signal.aborted) {
          resolve(undefined);
          return;
        }
        Promise.resolve()
          .then(() => callback({
            kind,
            toolCall: agyToolUse(merged),
            options: choices.map((choice) => ({ id: choice.optionId, name: choice.name ?? choice.optionId, kind: choice.kind ?? "" })),
          }, { signal: answered.signal }))
          .then((value) => resolve(value), () => resolve(undefined));
      });
      if (answered.signal.aborted) return cancelled;
      if (answer === undefined) return reject();
      if (answer === "cancel") return cancelled;
      return choices.some((choice) => choice.optionId === answer) ? selected(answer) : cancelled;
    } finally {
      pendingPermissions -= 1;
      target.ended.signal.removeEventListener("abort", fire);
      if (run === target) armInactivity();
    }
  });

  client.onStderr((chunk) => {
    const target = run;
    if (target) safeCallback(() => target.callbacks.onStderr?.(chunk));
  });

  client.onClose((error) => {
    const wasClosed = closed;
    closed = true;
    if (run) finish(run, { error });
    if (!wasClosed) interruptAgents();
  });

  // --- settings ----------------------------------------------------------

  /** What agy chose when the session opened, for the model id "default". */
  const defaults: { model?: string | undefined } = {};
  /** The settings request still in flight when a turn ended early: the next
   * turn waits for it rather than racing it. */
  let pendingSettings: Promise<void> = Promise.resolve();

  const setOption = async (option: ConfigOption, value: string): Promise<void> => {
    const response = await client.request("session/set_config_option", {
      sessionId,
      configId: option.id,
      value,
    });
    sentValues.set(option.id, value);
    if (isRecord(response)) applyConfig(response.configOptions);
  };

  const applySettings = async (wanted: { model?: string | undefined; effort?: string | undefined; mode?: string | undefined }): Promise<void> => {
    const { mode, model, effort } = wanted;
    if (mode !== undefined) {
      if (availableModes.length > 0 && !availableModes.includes(mode)) {
        throw new AgyTurnError(`agy mode "${mode}" is not one of ${availableModes.join(", ")}`, {
          kind: "invalid_request",
          code: "mode_unavailable",
        });
      }
      if (mode !== currentMode) {
        const modeOption = findOption(configOptions, "mode");
        if (modeOption) await setOption(modeOption, mode);
        else await client.request("session/set_mode", { sessionId, modeId: mode });
        currentMode = mode;
      }
    }
    const modelId = model === "default" ? defaults.model : model;
    if (modelId !== undefined) {
      const modelOption = findOption(configOptions, "model");
      if (modelOption) {
        const listed = modelOption.values.map((choice) => choice.value);
        const known = listed.includes(modelId) || listed.some((value) => modelId.startsWith(`${value}-`));
        if (!known) {
          throw new AgyTurnError(`agy model "${modelId}" is not available; choose one of ${listed.join(", ")}`, {
            kind: "invalid_request",
            code: "model_unavailable",
          });
        }
        const current = sentValues.get(modelOption.id) ?? modelOption.currentValue;
        if (modelId !== current) await setOption(modelOption, modelId);
      }
    }
    if (effort !== undefined) {
      const thought = findOption(configOptions, "thought_level");
      if (thought) {
        const levels = thought.values.map((choice) => choice.value);
        if (!levels.includes(effort)) {
          throw new AgyTurnError(`agy effort "${effort}" is not one of ${levels.join(", ")}`, {
            kind: "invalid_request",
            code: "effort_unavailable",
          });
        }
        if (effort !== thought.currentValue) await setOption(thought, effort);
      }
    }
  };

  // --- open --------------------------------------------------------------

  const meta = options.appendSystemPrompt && appendViaMeta
    ? { _meta: { antigravity: { systemPrompt: { append: options.appendSystemPrompt } } } }
    : {};
  const openParams = { cwd, mcpServers: acpMcpServers(options.mcpServers ?? []), ...meta };
  if (options.resumeSessionId && !capability(agent, "sessionCapabilities", "resume")) {
    throw new AgyTurnError("This agy cannot resume sessions", { kind: "unsupported", code: "resume_unsupported" });
  }
  let opened: unknown;
  try {
    opened = options.resumeSessionId
      ? await client.request("session/resume", { sessionId: options.resumeSessionId, ...openParams }, OPEN_TIMEOUT_MS)
      : await client.request("session/new", openParams, OPEN_TIMEOUT_MS);
  } catch (error) {
    throw agyRequestError(error, "agy could not open the session");
  }
  const openedRecord = isRecord(opened) ? opened : {};
  if (!options.resumeSessionId) {
    if (typeof openedRecord.sessionId !== "string" || !openedRecord.sessionId) {
      throw new AgyTurnError("agy did not return a session id");
    }
    sessionId = openedRecord.sessionId;
  }
  context.onOpened(sessionId);
  applyModes(openedRecord.modes);
  applyConfig(openedRecord.configOptions);
  defaults.model = findOption(configOptions, "model")?.currentValue;
  try {
    await applySettings({
      model: options.model,
      effort: options.effort,
      mode: isolated ? "default" : options.mode,
    });
  } catch (error) {
    throw agyRequestError(error, "agy could not apply the session's settings");
  }
  // A turn without its own settings returns to these, as Codex's turns
  // return to the thread's model.
  const baseline = {
    mode: currentMode,
    model: currentModel(),
    effort: findOption(configOptions, "thought_level")?.currentValue,
  };

  // --- turns -------------------------------------------------------------

  function newRun(kind: RunKind, callbacks: Run["callbacks"]): Run {
    return {
      kind,
      callbacks,
      done: createDeferred<RunResult>(),
      outstanding: 0,
      buffer: "",
      lastMessage: "",
      outputChars: 0,
      toolUses: new Set(),
      toolResults: new Set(),
      openTools: new Set(),
      agents: new Set(),
      holding: false,
      answered: false,
      replyOpen: false,
      repliedSinceAnswer: false,
      cancelRequested: false,
      compactionReported: false,
      ended: new AbortController(),
      steers: [],
    };
  }

  const interrupt = (target: Run, error: Error): void => {
    if (target.done.settled) return;
    target.interruption = error;
    target.ended.abort(); // pending permission requests answer "cancelled"
    if (target.outstanding === 0) {
      // Held for background work: the prompt has settled, so there is
      // nothing to cancel, and the background work keeps running.
      finish(target, { error });
      return;
    }
    target.cancelRequested = true;
    quietUntilPrompt = true;
    client.notify("session/cancel", { sessionId });
    const grace = setTimeout(() => {
      if (target.done.settled) return;
      void closeWith(error);
    }, interruptGraceMs);
    grace.unref?.();
    target.done.promise.then(() => clearTimeout(grace), () => clearTimeout(grace));
  };

  const start = async (
    kind: "turn" | "compact",
    turnOptions: AgentCallbacks & {
      prompt: string;
      imagePaths?: string[];
      signal?: AbortSignal;
      timeoutMs?: number;
      model?: string;
      effort?: string;
      mode?: string;
      onPermissionRequest?: AgyPermissionCallback;
    },
  ): Promise<RunResult> => {
    if (closed) throw new Error("agy session is closed");
    if (run && run.kind !== "continuation") throw new Error("agy session already has an active turn");
    if (turnOptions.signal?.aborted) throw runAborted("agy");

    // Reserve the session before the continuation's onEnd runs, so a turn it
    // starts is refused rather than run alongside this one.
    const previous = run;
    const target = newRun(kind, turnOptions);
    target.done.promise.catch(() => {});
    run = target;
    if (previous) {
      // A new turn takes over a continuation.
      flush(previous);
      finish(previous, { result: result(previous) });
    }

    const abort = () => interrupt(target, runAborted("agy"));
    turnOptions.signal?.addEventListener("abort", abort, { once: true });
    safeCallback(() => turnOptions.onSessionId?.(sessionId));
    const timer = turnOptions.timeoutMs === undefined
      ? undefined
      : setTimeout(() => interrupt(target, runTimedOut("agy", turnOptions.timeoutMs)), turnOptions.timeoutMs);
    // The turn settles on its own result: an abort or timeout does not wait
    // for a settings request agy has yet to answer.
    const prepare = async (): Promise<void> => {
      await pendingSettings;
      if (target.done.settled) return;
      const model = turnOptions.model === "default" ? defaults.model : turnOptions.model ?? baseline.model;
      // The session's effort may not exist on another model.
      const effort = turnOptions.effort ?? (model === baseline.model ? baseline.effort : undefined);
      const applying = applySettings({ model, effort, mode: isolated ? "default" : turnOptions.mode ?? baseline.mode });
      pendingSettings = applying.catch(() => {});
      await applying;
      if (target.done.settled) return;
      const blocks: Array<Record<string, unknown>> = [];
      // Without _meta the system prompt rides in front of the prompt, except
      // for a slash command such as /compact, which must come first.
      const text = options.appendSystemPrompt && !appendViaMeta && !turnOptions.prompt.startsWith("/")
        ? `${options.appendSystemPrompt}\n\n${turnOptions.prompt}`
        : turnOptions.prompt;
      blocks.push({ type: "text", text });
      if (turnOptions.imagePaths?.length) {
        const prompt = agent.capabilities.promptCapabilities;
        if (!isRecord(prompt) || prompt.image !== true) {
          throw new AgyTurnError("This agy takes no images", { kind: "unsupported", code: "images_unsupported" });
        }
        for (const path of turnOptions.imagePaths) blocks.push(await imageBlock(path));
      }
      if (kind === "compact" && lastUsage) target.usedBefore = lastUsage.contextTokens;
      await recordStepIndex(target);
      // agy sends no compaction event: the attempt starts with the /compact
      // prompt. Fired before the last check, so an abort from it sends nothing.
      if (kind === "compact" && !target.done.settled) {
        safeCallback(() => target.callbacks.onCompactionStart?.({ trigger: "manual" }));
      }
      if (target.done.settled || target.interruption) return;
      sendPrompt(target, blocks);
      armInactivity();
    };
    try {
      prepare().catch((error: unknown) => finish(target, { error: agyRequestError(error, "agy turn failed") }));
      return await target.done.promise;
    } finally {
      turnOptions.signal?.removeEventListener("abort", abort);
      if (timer) clearTimeout(timer);
    }
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    const wasClosed = closed;
    closed = true;
    if (run) finish(run, { error: new Error("agy session closed") });
    interruptAgents();
    closePromise = (async () => {
      if (!wasClosed && capability(agent, "sessionCapabilities", "close")) {
        await client.request("session/close", { sessionId }, CLOSE_TIMEOUT_MS).catch(() => {});
      }
      client.close();
      await whenExited;
      if (isolated || options.ephemeral) await removeAgySessionFiles(root, sessionId);
      await context.removeTempCwd();
    })();
    return closePromise;
  };

  return {
    get sessionId() {
      return sessionId;
    },
    cwd,
    get closed() {
      return closed;
    },
    outcomeSource: stepReader ? "steps-db" : "stop-reason",
    runTurn(turnOptions) {
      return start("turn", turnOptions);
    },
    compact(compactOptions) {
      if (!availableCommands.has("compact")) {
        return Promise.reject(new AgyTurnError("This agy session offers no /compact command", {
          kind: "unsupported",
          code: "compaction_unsupported",
        }));
      }
      const prompt = compactOptions.instructions ? `/compact ${compactOptions.instructions}` : "/compact";
      return start("compact", { ...compactOptions, prompt });
    },
    steer({ prompt }) {
      const target = run;
      if (closed || !target || target.kind !== "turn" || target.outstanding === 0 || target.done.settled || target.cancelRequested) {
        return Promise.reject(new SteerRejectedError("agy session has no prompt running to steer"));
      }
      const accepted = createDeferred<void>();
      sendPrompt(target, [{ type: "text", text: prompt }], accepted);
      return accepted.promise;
    },
    onClose(handler) {
      return client.onClose(handler);
    },
    close,
  };
}
