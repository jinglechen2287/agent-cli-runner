import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface HookInput {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_use_id?: unknown;
}

interface HookState {
  mode?: unknown;
  toolUseId?: unknown;
  updatedInput?: unknown;
}

type HookOutput = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function deferOutput(): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "defer",
    },
  };
}

/** Process one Claude PreToolUse invocation. Exported for deterministic tests;
 * the compiled entry point below is what Claude Code executes. */
export function processClaudeQuestionHook(input: unknown, statePath: string): HookOutput {
  const hook = record(input) as HookInput | undefined;
  if (hook?.hook_event_name !== "PreToolUse" || hook.tool_name !== "AskUserQuestion") {
    return {};
  }
  const state = JSON.parse(readFileSync(statePath, "utf8")) as HookState;
  if (
    state.mode !== "answer"
    || typeof state.toolUseId !== "string"
    || state.toolUseId !== hook.tool_use_id
    || !record(state.updatedInput)
  ) {
    return deferOutput();
  }
  const updatedInput = state.updatedInput as Record<string, unknown>;
  // Consume the answer before returning it. A later question in the same
  // resumed process must defer instead of receiving this answer by mistake.
  writeFileSync(statePath, JSON.stringify({ mode: "defer" }), { mode: 0o600 });
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  };
}

async function main(): Promise<void> {
  const statePath = process.argv[2];
  if (!statePath) {
    process.exitCode = 2;
    return;
  }
  let input = "";
  for await (const chunk of process.stdin) input += chunk.toString();
  try {
    const output = processClaudeQuestionHook(JSON.parse(input), statePath);
    process.stdout.write(JSON.stringify(output));
  } catch {
    // Do not echo malformed hook input or state: either may contain answers.
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
