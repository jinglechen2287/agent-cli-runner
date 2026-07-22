type HookOutput = Record<string, unknown>;
/** Process one Claude PreToolUse invocation. Exported for deterministic tests;
 * the compiled entry point below is what Claude Code executes. */
declare function processClaudeQuestionHook(input: unknown, statePath: string): HookOutput;

export { processClaudeQuestionHook };
