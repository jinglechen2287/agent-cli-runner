// src/claude-question-hook.ts
import { readFileSync, writeFileSync } from "fs";
import { pathToFileURL } from "url";
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function deferOutput() {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "defer"
    }
  };
}
function processClaudeQuestionHook(input, statePath) {
  const hook = record(input);
  if (hook?.hook_event_name !== "PreToolUse" || hook.tool_name !== "AskUserQuestion") {
    return {};
  }
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (state.mode !== "answer" || typeof state.toolUseId !== "string" || state.toolUseId !== hook.tool_use_id || !record(state.updatedInput)) {
    return deferOutput();
  }
  const updatedInput = state.updatedInput;
  writeFileSync(statePath, JSON.stringify({ mode: "defer" }), { mode: 384 });
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput
    }
  };
}
async function main() {
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
    process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
export {
  processClaudeQuestionHook
};
//# sourceMappingURL=claude-question-hook.js.map