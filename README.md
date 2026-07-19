# agent-cli-runner

Spawn and stream the [Claude Code](https://claude.com/claude-code) and [Codex](https://developers.openai.com/codex/cli) CLIs from Node or Bun: session resume, JSONL event parsing, streaming callbacks, and abort/timeout handling — with zero runtime dependencies.

Extracted from two apps that each talked to both CLIs; this package is the shared protocol layer.

## Install

The `dist/` build is committed, so a plain git dependency works with both pnpm and Bun:

```sh
pnpm add agent-cli-runner@github:jinglechen2287/agent-cli-runner
bun add agent-cli-runner@github:jinglechen2287/agent-cli-runner
```

Requires Node ≥ 18 (or Bun — it uses `node:child_process`, which Bun implements) and the `claude` / `codex` binaries on `PATH` (or pass `executablePath`).

## Usage

```ts
import { runClaude, runCodex } from "agent-cli-runner";

// First turn: pre-assign a session id.
const first = await runClaude({
  prompt: "Make the button round",
  cwd: "/path/to/project",
  newSessionId: crypto.randomUUID(),
  appendSystemPrompt: "You are editing a running web app.",
  onAssistantText: (text) => console.log(text),
  onToolUse: ({ name }) => console.log(`tool: ${name}`),
  onToolResult: ({ callId }) => console.log(`tool result: ${callId}`),
});

// Follow-up turn: resume it.
const followUp = await runClaude({
  prompt: "Now make it blue",
  cwd: "/path/to/project",
  resumeSessionId: first.sessionId,
});

// Codex works the same way; the thread id arrives in the result.
const codex = await runCodex({
  prompt: "Make the button round",
  cwd: "/path/to/project",
  developerInstructions: "You are editing a running web app.",
  imagePaths: ["/tmp/screenshot.png"],
  dangerouslyBypassApprovalsAndSandbox: true, // opt-in; see below
});
await runCodex({ prompt: "Now blue", cwd: "/path/to/project", resumeSessionId: codex.sessionId });
```

Both functions resolve to a `RunResult`:

```ts
interface RunResult {
  text: string;      // final assistant text ("" if none)
  exitCode: number;
  sessionId?: string; // Claude session id / Codex thread id
}
```

### Common options

| Option | Meaning |
| --- | --- |
| `prompt`, `cwd` | Required. The prompt is written to stdin, never argv. |
| `executablePath` | Binary path; defaults to `"claude"` / `"codex"` on `PATH`. |
| `signal` | `AbortSignal`; on abort the child gets SIGTERM, then SIGKILL after 2 s, and the promise rejects with `AbortError`. |
| `timeoutMs` | Optional wall-clock limit; same kill path, rejects `TimeoutError`. No timeout by default. |
| `env` | Base child environment (default `process.env`). Nesting-guard variables (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ACCESS_TOKEN` for Claude; `CODEX_THREAD_ID` for Codex) are always stripped. |
| `spawnFn` | Injectable spawn primitive for tests. |
| `onSessionId`, `onAssistantText`, `onToolUse`, `onToolResult`, `onStderr` | Streaming callbacks. Claude tool uses and results share a provider call ID so hosts can correlate them. Codex tool items are mapped to Claude-style tool names (`command_execution` → `Bash`, `file_change` → `Edit`, …). |

### Claude-specific

`appendSystemPrompt` (passed on every turn — the CLI rebuilds the system prompt from flags each run), `newSessionId` / `resumeSessionId` (mutually exclusive).

### Codex-specific

`developerInstructions`, `resumeSessionId`, `imagePaths`, `dangerouslyBypassApprovalsAndSandbox`. Codex always gets `--skip-git-repo-check` and is spawned as a detached process-group leader so aborts kill its whole tool subtree. `--dangerously-bypass-approvals-and-sandbox` (full host access, no approval prompts) is **off by default** — set `dangerouslyBypassApprovalsAndSandbox: true` only for trusted prompts in environments you accept the agent can modify.

### Errors

`AbortError`, `TimeoutError`, `MissingCliError` (ENOENT; carries `.cli`), `CodexTurnError` (fatal `error` / `turn.failed` stream events; carries `.exitCode`).

## Develop

```sh
pnpm install
pnpm test        # vitest
pnpm typecheck
pnpm build       # tsup → dist/ (commit the result)
```

## License

MIT
