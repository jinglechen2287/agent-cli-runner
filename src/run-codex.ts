import { spawn as nodeSpawn } from "node:child_process";
import { CodexTurnError, MissingCliError } from "./errors.js";
import {
  createLineSplitter,
  filterEnv,
  isMissingExecutable,
  signalProcessTree,
  watchLifecycle,
  writePrompt,
} from "./internal.js";
import type { CommonRunOptions, RunResult } from "./types.js";

/** Stripped so a Codex turn spawned from within another Codex session does
 * not inherit the parent's thread. */
export const CODEX_STRIPPED_ENV_VARS = ["CODEX_THREAD_ID"] as const;

export interface RunCodexOptions extends CommonRunOptions {
  /** Pass `--dangerously-bypass-approvals-and-sandbox` so Codex runs with
   * full host access and no approval prompts. Off by default — only enable
   * this for trusted prompts in environments you accept it can modify. */
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  /** Text passed via `-c developer_instructions=...` on every turn. */
  developerInstructions?: string;
  /** Resume an existing thread by id (turn 2+). */
  resumeSessionId?: string;
  /** Image paths passed via repeated `-i` flags. */
  imagePaths?: string[];
}

interface CodexStreamEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: unknown;
  item?: Record<string, unknown>;
}

function toolName(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case "command_execution":
      return "Bash";
    case "file_change":
      return "Edit";
    case "mcp_tool_call":
      return typeof item.tool === "string" ? item.tool : "MCP";
    case "web_search":
      return "WebSearch";
    case "todo_list":
    case "plan_update":
      return "TodoWrite";
    default:
      return null;
  }
}

function fatalEventError(event: CodexStreamEvent): CodexTurnError | null {
  if (event.type !== "error" && event.type !== "turn.failed") return null;
  let detail: string | undefined;
  if (typeof event.message === "string") {
    detail = event.message;
  } else if (typeof event.error === "string") {
    detail = event.error;
  } else if (event.error && typeof event.error === "object") {
    const message = (event.error as Record<string, unknown>).message;
    if (typeof message === "string") detail = message;
  }
  const label = event.type === "turn.failed" ? "Codex turn failed" : "Codex error";
  return new CodexTurnError(detail ? `${label}: ${detail}` : label);
}

function buildArgs(opts: RunCodexOptions): string[] {
  const args = opts.resumeSessionId
    ? ["exec", "resume", "--json"]
    : ["exec", "--json"];
  if (opts.dangerouslyBypassApprovalsAndSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  args.push("--skip-git-repo-check");
  if (opts.developerInstructions !== undefined) {
    args.push("-c", `developer_instructions=${JSON.stringify(opts.developerInstructions)}`);
  }
  for (const imagePath of opts.imagePaths ?? []) {
    args.push("-i", imagePath);
  }
  if (opts.resumeSessionId) args.push(opts.resumeSessionId);
  // "-" makes `codex exec` read the prompt from stdin.
  args.push("-");
  return args;
}

/** Spawn a non-interactive Codex CLI turn (`codex exec --json`) and translate
 * its JSONL stream into the same callbacks used by the Claude runner. */
export async function runCodex(opts: RunCodexOptions): Promise<RunResult> {
  const spawnFn = opts.spawnFn ?? nodeSpawn;
  const child = spawnFn(opts.executablePath ?? "codex", buildArgs(opts), {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: filterEnv(opts.env ?? process.env, CODEX_STRIPPED_ENV_VARS),
    detached: process.platform !== "win32",
  });
  writePrompt(child, opts.prompt);

  return new Promise<RunResult>((resolve, reject) => {
    let settled = false;
    let sessionId: string | undefined;
    let finalText: string | undefined;
    let fatalError: CodexTurnError | undefined;
    const emittedTools = new Set<string>();

    const lifecycle = watchLifecycle({
      cli: "codex",
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      kill: (signal) => signalProcessTree(child, signal),
    });

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: CodexStreamEvent;
      try {
        event = JSON.parse(trimmed) as CodexStreamEvent;
      } catch {
        return;
      }
      const eventError = fatalEventError(event);
      if (eventError) {
        fatalError ??= eventError;
        return;
      }
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        sessionId = event.thread_id;
        opts.onSessionId?.(event.thread_id);
        return;
      }
      if (event.type !== "item.started" && event.type !== "item.completed") {
        return;
      }
      const item = event.item;
      if (!item) return;
      if (
        event.type === "item.completed" &&
        item.type === "agent_message" &&
        typeof item.text === "string"
      ) {
        finalText = item.text;
        opts.onAssistantText?.(item.text);
        return;
      }
      const name = toolName(item);
      if (!name) return;
      const id = typeof item.id === "string" ? item.id : `${item.type}:${name}`;
      if (emittedTools.has(id)) return;
      emittedTools.add(id);
      opts.onToolUse?.({ name });
    };

    const splitter = createLineSplitter(handleLine);
    child.stdout?.on("data", (chunk: Buffer | string) => splitter.push(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      opts.onStderr?.(chunk.toString());
    });

    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      lifecycle.cleanup();
      reject(isMissingExecutable(error) ? new MissingCliError("codex") : error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      splitter.flush();
      lifecycle.cleanup();
      const interruption = lifecycle.interruptionError();
      if (interruption) {
        reject(interruption);
        return;
      }
      if (fatalError) {
        fatalError.exitCode = code ?? -1;
        reject(fatalError);
        return;
      }
      resolve({
        text: (finalText ?? "").trim(),
        exitCode: code ?? -1,
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
    });
  });
}
