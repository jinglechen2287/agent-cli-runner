# agent-cli-runner

Stream [Claude Code](https://claude.com/claude-code) and [Codex app-server](https://developers.openai.com/codex/app-server) from Node or Bun: session resume, tool events, live usage, and abort/timeout handling. Claude runs over the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — the package's runtime dependency, along with the SDK's peers (`zod`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`) — against your installed `claude` binary.

Extracted from two apps that each talked to both CLIs; this package is the shared protocol layer.

## Install

The `dist/` build is committed, so a plain git dependency works with both pnpm and Bun:

```sh
pnpm add agent-cli-runner@github:jinglechen2287/agent-cli-runner
bun add agent-cli-runner@github:jinglechen2287/agent-cli-runner
```

Requires Node ≥ 18.14 (or Bun — it uses `node:child_process`, which Bun implements) and the `claude` / `codex` binaries on `PATH` (or pass `executablePath`).

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
| `prompt`, `cwd` | Required. Prompts never appear in argv: Claude uses the Agent SDK's stream-json input, isolated Codex uses stdin, and regular Codex turns use app-server JSON-RPC. |
| `executablePath` | Binary path; defaults to `"claude"` / `"codex"` on `PATH`. |
| `signal` | `AbortSignal`; Claude and regular Codex interrupt the turn (a Claude session then closes; if the interrupt goes unanswered for 5 s, shutdown starts anyway, sending the process tree SIGTERM and then SIGKILL after a further 2 s), while isolated Codex terminates its process tree. Rejects with `AbortError`. |
| `timeoutMs` | Optional wall-clock limit using the provider-appropriate interruption path; rejects `TimeoutError`. No timeout by default. |
| `env` | Base child environment (default `process.env`). Nesting-guard variables (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ACCESS_TOKEN` for Claude; `CODEX_THREAD_ID` for Codex) are always stripped. |
| `spawnFn` | Injectable spawn primitive for tests. |
| `onSessionId`, `onAssistantText`, `onToolUse`, `onToolResult`, `onBackgroundAgentUpdate`, `onUsage`, `onStderr` | Streaming callbacks. Tool uses and results share a provider call ID. Codex app-server items are mapped to shared names (`commandExecution` → `Bash`, `fileChange` → `Edit`, web page operations → `WebFetch`) and plan notifications become normalized `TodoWrite` snapshots. Background subagents emit replace-in-place snapshots keyed by child thread id; their tool events stay in the parent stream, but their prose is excluded from `onAssistantText` (matching the delta stream). Usage snapshots describe the latest request's context occupancy, never cumulative turn totals; isolated Codex runs report the `codex exec` turn summary, which coincides with occupancy on their single-request metadata turns. |
| `onAssistantTextDelta` | Assistant prose as the model produces it. Claude always streams partial messages and only forwards them when this is supplied; for Codex, supplying it subscribes to `item/agentMessage/delta`. Fragments exclude extended thinking, streamed tool input, and background-subagent prose, and concatenate to the next `onAssistantText` message — treat them as scratch state that the completed message supersedes. Not emitted by isolated Codex runs. |

### Provider update checks

`createProviderUpdateService` performs read-only update checks using each CLI's native release metadata:

```ts
import { createProviderUpdateService } from "agent-cli-runner";

const updates = createProviderUpdateService({
  claudePath: "/path/to/claude", // defaults to "claude"
  codexPath: "/path/to/codex",   // defaults to "codex"
});

const claude = await updates.check("claude");
const all = await updates.checkAll(); // Claude and Codex concurrently
```

Every check reports `current`, `update_available`, `not_installed`, or `unknown`, together with the installed/latest versions and a stable reason when detection is unavailable. Expected command, parsing, and network failures are returned as status data rather than thrown.

Claude detection is intentionally definitive only for native installations. It reads the installation method and `stable` / `latest` channel from `claude doctor`, then compares against that channel at `downloads.claude.ai`; package-manager installations return `unknown` instead of risking a cross-channel false positive. Codex reads the latest version from `codex doctor --json` and accepts its JSON even when unrelated diagnostics make the command exit nonzero. Older Codex versions without update metadata return `unknown`; there is no npm fallback.

Checks use five-second command and network timeouts — thirty seconds for `codex doctor --json`, which checks the whole installation, network and database included — and strip the same provider nesting-guard environment variables as agent runs. They never invoke `claude update`, `codex update`, or a package manager, and they do not cache results.

### Claude-specific

`model`, `effort`, `appendSystemPrompt` (appended to the Claude Code system prompt; supply it on every run), `permissionMode`, `tools` (`["default"]` is the full set, `[]` disables every built-in), `allowedTools` (pre-approval only), `disallowedTools`, `settingSources`, `settings`, `hooks` (in-process Agent SDK hook callbacks), `newSessionId` / `resumeSessionId` (mutually exclusive), and `isolated`. `executablePath` is resolved through `PATH` up front, so a missing binary rejects with `MissingCliError`; the SDK's bundled binary is never used.

A hook callback that throws counts as "no opinion" to the CLI, so a guard hook must catch its own errors and return an explicit `deny`.

`isolated: true` is for non-persistent one-shot metadata requests. It requires Claude Code 2.1.169 or newer because it enables `--safe-mode`; it also disables built-in tools and MCP servers and prevents session persistence. It cannot resume a session.

`forkSessionId` forks an existing session for a side run, such as a question asked while that session is mid-turn. The fork sees the session's whole history, including the current turn's completed tool results, and the fork's conversation is never saved, so the original session never sees the exchange. With `isolated: true` it has no tools, and a PreToolUse hook denies any it reaches for. Without it, the fork keeps the `tools`, `allowedTools`, `permissionMode`, `settings`, `settingSources` and `hooks` you pass, exactly as a guarded session would — so whatever those tools change on disk stays changed, and the original session can see it. The fork must run from the original session's `cwd`, because Claude finds sessions by project directory. It is mutually exclusive with `newSessionId` and `resumeSessionId`.

`runClaude` starts a session, runs one turn, and closes it. To keep the CLI up between turns, hold a session instead:

```ts
import { createClaudeSession } from "agent-cli-runner";

const session = await createClaudeSession({
  cwd: "/path/to/project",
  newSessionId: crypto.randomUUID(),
  tools: ["default"],
});
await session.runTurn({ prompt: "Make the button round", onAssistantText: console.log });
await session.runTurn({ prompt: "Now make it blue" });
await session.close();
```

Session settings (model, effort, permission mode, tools, hooks, system prompt, environment) are fixed for the life of the session; open a new one, resuming the same id, to change them. Turns run one at a time. Each prompt is stamped with a uuid, and a turn ends only on a `result` that answers it, so the empty result a resumed CLI writes for a task an earlier process left running is not taken for the turn's own (CLIs that do not echo the uuid fall back to treating an empty result before any output as foreign). A turn whose model started a background subagent stays open past its own `result` until every subagent has reported back and the CLI has answered the notification with a further `result` — whose text becomes the turn's — or until the CLI has gone `followUpGraceMs` (default 60 s) without a message while that result is due. A session closes itself — firing `onClose` — when its process exits, after an interrupted (aborted or timed-out) turn, when a turn ends with a background shell or Monitor still running, or when the CLI produces output between turns. A live process would hand a stopped request back to the model with the next prompt, so a stop always ends in a resume from disk; stopping a turn that is only waiting on subagents closes the session at once, since an idle CLI writes no result for the interrupt.

### Codex-specific

Regular Codex turns use the app-server V2 `thread/*` and `turn/*` flow. Options include `developerInstructions`, `resumeSessionId`, `imagePaths`, `model`, `reasoningEffort`, `dangerouslyBypassApprovalsAndSandbox`, `appServerClient`, `appServerSession`, and `isolated`. Images become `localImage` inputs, reasoning effort is sent on `turn/start`, usage streams from `thread/tokenUsage/updated`, and cancellation uses `turn/interrupt`.

`dangerouslyBypassApprovalsAndSandbox` is **off by default**. Enabling it maps to app-server's `approvalPolicy: "never"` and `sandbox: "danger-full-access"`; use it only for trusted prompts in environments you accept the agent can modify.

By default each regular `runCodex` call owns one app-server process. For a thread-bound long-running process, create a `CodexAppServerSession` with `createCodexAppServerSession(...)`; it initializes and starts or resumes the thread once, then its `runTurn(...)` method reuses that thread until the owner calls and awaits `session.close()`. Lower-level hosts can instead create a reusable connection with `createCodexAppServerClient(...)` and pass it as `appServerClient`; a shared client can route concurrent turns by thread and turn id. Native in-turn question and approval requests are not enabled; unsupported server requests receive a JSON-RPC method-not-found response.

An abort or timeout while `turn/start` is still unacknowledged cannot be unwound cleanly: the runner best-effort interrupts the turn when it is identifiable, then retires the app-server process if it owns it (per-turn clients, and sessions — the session reports `closed` and its host starts a fresh one). A borrowed `appServerClient` is never closed, since other threads may be mid-turn on it; its owner should treat the affected thread as suspect and decide the client's lifecycle itself.

For new threads, the runner opts into Codex raw response items so hosted web page operations can retain their resolved URL even when the public `webSearch` completion reports only `action: "other"`. It correlates only a single unambiguous `web__run` invocation, extracts the page-header URL, and discards the raw payload. Ambiguous calls fall back to the ordinary completed item without inventing details. Resumed threads created without raw events still receive correct search/fetch classification and any URL or find pattern present in their completed items.

`isolated: true` remains on `codex exec` because app-server cannot currently reproduce both per-run ignore flags. It uses an ephemeral session, ignores user config and exec-policy rules, and enforces a read-only sandbox. `model` and `reasoningEffort` are honored (effort maps to the `model_reasoning_effort` config override), and usage is reported from the exec turn summary. It cannot resume a thread, set a `serviceTier` or `sandboxPolicy`, or be combined with `dangerouslyBypassApprovalsAndSandbox`.

`forkSessionId` forks an existing thread for a side run on a one-off app-server, not `codex exec`. It sends `thread/fork` with `ephemeral: true`, a read-only sandbox and `approvalPolicy: "never"`. The fork sees the thread's history, including the current turn's completed items, and nothing it does is written back to the thread. With `isolated: true`, it also sends `CODEX_FORK_CONFIG`, which turns off web search and every tool feature, and switches off each configured MCP server by name. If a tool item starts anyway, the run sends `turn/interrupt` and rejects with `CodexTurnError`. Without `isolated`, the fork keeps Codex's tools, and `turn/start` carries your `sandboxPolicy`, which must be `readOnly`. That bounds the fork's shell, not everything it can reach: network access, exec-policy rules that allow a command outside the sandbox, and MCP tools approved in the user's Codex config can still act, exactly as they could in an ordinary read-only turn. A guarded fork's `forkConfig` goes on `thread/fork` as its config overrides, such as an MCP server for that fork alone. A fork cannot be combined with `resumeSessionId`, `appServerClient`, `appServerSession`, `turnCwd`, or `dangerouslyBypassApprovalsAndSandbox`; an isolated one cannot take a `sandboxPolicy` either.

### MCP servers

Claude runs and Codex sessions report their MCP servers through two callbacks. A one-off Codex run reports neither.

`onMcpStatus` receives a snapshot of every server the CLI reports, as `{ name, status, error? }`, where `status` is `connecting`, `connected`, `failed`, `needs-auth` or `disabled`. Claude lists disabled servers; Codex only reports the ones it starts. It fires at the start of each turn on a long-lived session and whenever a server changes during one. Claude's errors come from the SDK's `mcpServerStatus()`, polled every 2 seconds for up to 30 while a server is still connecting; a failed status call keeps the last snapshot and never affects the turn.

`onMcpElicitation` answers a server's request for user input while its tool call waits. It receives a `form` request with a `requestedSchema`, or a `url` request, and returns `{ action, content? }`. Without it the request is declined; a throw cancels it. Its `signal` fires when the request stops mattering, such as when the turn ends.

Claude hands over every form and URL request. Codex decides first, based on its approval policy:

| Codex turn | Forms with fields | Confirm (no fields) | URL |
| --- | --- | --- | --- |
| `approvalPolicy: "never"`, full access | Handed over | Auto-accepted by Codex | Declined by Codex |
| `approvalPolicy: "never"`, restricted sandbox | Declined by Codex | Declined by Codex | Declined by Codex |

To surface forms, a session declares the `openai/standard-form-input` extension and starts its threads with `threadSource: "user"`. A thread that was started without it and later resumed may not surface them. Other policies would surface more, but they also route MCP tool approvals through the same prompts, which changes how unattended turns behave, so the runner leaves the policy alone. Codex-only modes (`openai/form`, `openaiForm`) are declined.

Codex reports MCP tools as `mcp__<server>__<tool>`, the form Claude uses.

### Compaction

Both long-lived sessions can compact their conversation with the CLI's own compaction, as a turn of its own:

```ts
await claudeSession.compact({ instructions: "keep the API decisions", onUsage, onCompaction });
await codexSession.compact({ onUsage, onCompaction });
```

`ClaudeSession.compact` sends Claude Code's `/compact`, with the optional `instructions` after it. Once the CLI's `compact_boundary` arrives, the session counts what is left with the SDK's `getContextUsage({ detail: "full" })`, which takes about 200 ms. It reports that count through `onUsage` and the result's `usage`. If the count fails or takes more than 10 seconds, the turn settles without a size. The boundary's own `post_tokens` is not used: Claude counts it differently from `contextTokens`.

`CodexAppServerSession.compact` sends `thread/compact/start`, which takes no instructions. Its reply names no turn, so the session takes the turn from `turn/started`, waiting as long as a `turn/start` reply may take. After that, it runs like any turn, and Stop sends `turn/interrupt`. Codex reports its estimate of the compacted history through `thread/tokenUsage/updated`, which arrives as `onUsage`.

Either way the result's `text` is empty, and the compaction can't be steered. `onCompaction` receives `{ trigger, preTokens?, postTokens? }` for a requested compaction and for one the CLI starts on its own mid-turn. After an automatic Claude compaction, a turn reports no size until a later request in it measures one.

### Lasting forks

A run's `forkSessionId` makes a throwaway copy. To copy a conversation that a new session carries on from, fork it without running a turn:

```ts
const claudeCopy = await forkClaudeSession(sessionId, { cwd });
const codexCopy = await forkCodexThread({ threadId, cwd, executablePath, timeoutMs, signal });
```

Each answers the copy's id, which `resumeSessionId` then continues; later turns on the original and the copy don't see each other. `forkClaudeSession` copies the session file under new ids with the SDK's `forkSession`, reading and writing where the CLI keeps sessions for `cwd` (under this process's `CLAUDE_CONFIG_DIR`, or the default). `deleteClaudeSession(sessionId, { cwd })` deletes one, such as a copy nothing took up. `forkCodexThread` starts a one-shot app-server, sends `thread/fork` with `ephemeral: false`, and closes the app-server however the fork ends. `timeoutMs` (default 60 s) bounds the whole fork; an abort rejects with `AbortError`. Codex has no call that deletes a thread.

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
