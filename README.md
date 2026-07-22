# agent-cli-runner

Stream [Claude Code](https://claude.com/claude-code) and [Codex app-server](https://developers.openai.com/codex/app-server) from Node or Bun: session resume, tool events, live usage, and abort/timeout handling — with zero runtime dependencies.

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
  onBackgroundAgentUpdate: (agent) => console.log(`${agent.id}: ${agent.status}`),
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
  usage?: TokenUsage; // latest context occupancy, when reported
}
```

### Common options

| Option | Meaning |
| --- | --- |
| `prompt`, `cwd` | Required. Prompts never appear in argv: Claude and isolated Codex use stdin; regular Codex turns use app-server JSON-RPC. |
| `executablePath` | Binary path; defaults to `"claude"` / `"codex"` on `PATH`. |
| `signal` | `AbortSignal`; Claude and isolated Codex terminate their process tree, while regular Codex sends `turn/interrupt`. Rejects with `AbortError`. |
| `timeoutMs` | Optional wall-clock limit using the provider-appropriate interruption path; rejects `TimeoutError`. No timeout by default. |
| `env` | Base child environment (default `process.env`). Nesting-guard variables (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ACCESS_TOKEN` for Claude; `CODEX_THREAD_ID` for Codex) are always stripped. |
| `spawnFn` | Injectable spawn primitive for tests. |
| `onSessionId`, `onAssistantText`, `onToolUse`, `onToolResult`, `onBackgroundAgentUpdate`, `onUsage`, `onStderr` | Streaming callbacks. Tool uses and results share a provider call ID. Codex app-server items are mapped to shared names (`commandExecution` → `Bash`, `fileChange` → `Edit`, web page operations → `WebFetch`) and plan notifications become normalized `TodoWrite` snapshots. Background subagents emit replace-in-place snapshots keyed by child thread id. Usage snapshots describe the latest request's context occupancy, never cumulative turn totals. |
| `onAssistantTextDelta` | Assistant prose as the model produces it. Opt-in: supplying it adds Claude's `--include-partial-messages` (roughly doubling CLI output) and subscribes to Codex's `item/agentMessage/delta`. Fragments exclude extended thinking, streamed tool input, and background-subagent prose, and concatenate to the next `onAssistantText` message — treat them as scratch state that the completed message supersedes. Not emitted by isolated Codex runs. |
| `onUserInputRequest` | Async callback for provider-native questions. Return answers keyed by normalized question id; the current turn resumes in place. Option descriptions are preserved when providers supply them. |

### Claude-specific

`appendSystemPrompt` (passed on every turn — the CLI rebuilds the system prompt from flags each run), `newSessionId` / `resumeSessionId` (mutually exclusive), and `isolated`.

`isolated: true` is for non-persistent one-shot metadata requests. It requires Claude Code 2.1.169 or newer because it enables `--safe-mode`; it also disables built-in tools and MCP servers and prevents session persistence. It cannot resume a session.

Native `AskUserQuestion` support keeps the `claude -p` subprocess architecture. When `onUserInputRequest` is supplied, the runner installs a temporary `PreToolUse` hook, defers the tool, waits for the callback, and resumes the same session. This requires Claude Code 2.1.89 or newer; the runner checks the installed version before starting a question-enabled turn. Multi-select labels are encoded as Claude's comma-separated answer string. Hook settings and answers use restricted temporary files and are removed when the logical turn ends.

### Codex-specific

Regular Codex turns use the app-server V2 `thread/*` and `turn/*` flow. Options include `developerInstructions`, `resumeSessionId`, `imagePaths`, `model`, `reasoningEffort`, `dangerouslyBypassApprovalsAndSandbox`, `appServerClient`, `appServerSession`, and `isolated`. Images become `localImage` inputs, reasoning effort is sent on `turn/start`, usage streams from `thread/tokenUsage/updated`, and cancellation uses `turn/interrupt`.

`dangerouslyBypassApprovalsAndSandbox` is **off by default**. Enabling it maps to app-server's `approvalPolicy: "never"` and `sandbox: "danger-full-access"`; use it only for trusted prompts in environments you accept the agent can modify.

By default each regular `runCodex` call owns one app-server process. For a thread-bound long-running process, create a `CodexAppServerSession` with `createCodexAppServerSession(...)`; it initializes and starts or resumes the thread once, then its `runTurn(...)` method reuses that thread until the owner calls and awaits `session.close()`. Lower-level hosts can instead create a reusable connection with `createCodexAppServerClient(...)` and pass it as `appServerClient`; a shared client can route concurrent turns by thread and turn id. Native `item/tool/requestUserInput` requests use `onUserInputRequest`; other unsupported server requests receive a JSON-RPC method-not-found response.

For new threads, the runner opts into Codex raw response items so hosted web page operations can retain their resolved URL even when the public `webSearch` completion reports only `action: "other"`. It correlates only a single unambiguous `web__run` invocation, extracts the page-header URL, and discards the raw payload. Ambiguous calls fall back to the ordinary completed item without inventing details. Resumed threads created without raw events still receive correct search/fetch classification and any URL or find pattern present in their completed items.

`isolated: true` remains on `codex exec` because app-server cannot currently reproduce both per-run ignore flags. It uses an ephemeral session, ignores user config and exec-policy rules, and enforces a read-only sandbox. It cannot resume a thread or be combined with `dangerouslyBypassApprovalsAndSandbox`.

### Errors

`AbortError`, `TimeoutError`, `MissingCliError` (ENOENT; carries `.cli`), and `CodexTurnError` (fatal Codex turn notifications; isolated exec failures may also carry `.exitCode`).

## Develop

```sh
pnpm install
pnpm test        # vitest
pnpm typecheck
pnpm build       # tsup → dist/ (commit the result)
```

## License

MIT
