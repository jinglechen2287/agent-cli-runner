# agent-cli-runner

Stream [Claude Code](https://claude.com/claude-code), [Codex app-server](https://developers.openai.com/codex/app-server) and the [Antigravity CLI](https://antigravity.google/product/antigravity-cli) (`agy`) from Node or Bun: session resume, tool events, live usage, and abort/timeout handling. Claude runs over the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — the package's runtime dependency, along with the SDK's peers (`zod`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`) — against your installed `claude` binary.

Extracted from two apps that each talked to both CLIs; this package is the shared protocol layer.

## Install

The `dist/` build is committed, so a plain git dependency works with both pnpm and Bun:

```sh
pnpm add agent-cli-runner@github:jinglechen2287/agent-cli-runner
bun add agent-cli-runner@github:jinglechen2287/agent-cli-runner
```

Requires Node ≥ 18.14 (or Bun — it uses `node:child_process`, which Bun implements) and the `claude` / `codex` / `agy` binaries on `PATH` (or pass `executablePath`).

Upgrading to 0.8: the provider unions (`AgentProvider`, `ModelCatalogProvider`, `ProviderUpdateProvider`, `BackgroundAgentInfo.provider`) gained `"agy"`, and `checkAll()` returns three statuses. An exhaustive switch over a provider needs an `"agy"` case.

## Usage

```ts
import { runAgy, runClaude, runCodex } from "agent-cli-runner";

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

// agy runs over its ACP server (`agy acp`).
const agy = await runAgy({
  prompt: "Make the button round",
  cwd: "/path/to/project",
  appendSystemPrompt: "You are editing a running web app.",
});
await runAgy({ prompt: "Now blue", cwd: "/path/to/project", resumeSessionId: agy.sessionId });
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
| `executablePath` | Binary path; defaults to `"claude"` / `"codex"` / `"agy"` on `PATH`. |
| `signal` | `AbortSignal`; Claude and regular Codex interrupt the turn (a Claude session then closes; if the interrupt goes unanswered for 5 s, shutdown starts anyway, sending the process tree SIGTERM and then SIGKILL after a further 2 s), while isolated Codex terminates its process tree. agy sends `session/cancel` and waits up to 15 s for the prompt to answer; the session stays usable when it does, and closes when it doesn't. Rejects with `AbortError`. |
| `timeoutMs` | Optional wall-clock limit using the provider-appropriate interruption path; rejects `TimeoutError`. No timeout by default. |
| `env` | Base child environment (default `process.env`). Nesting-guard variables (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ACCESS_TOKEN` for Claude; `CODEX_THREAD_ID` for Codex; `ANTIGRAVITY_CONVERSATION_ID` for agy) are always stripped. |
| `spawnFn` | Injectable spawn primitive for tests. |
| `onSessionId`, `onAssistantText`, `onToolUse`, `onToolResult`, `onBackgroundAgentUpdate`, `onUsage`, `onCompaction`, `onCompactionStart`, `onCompactionFailed`, `onStderr` | Streaming callbacks. Tool uses and results share a provider call ID. A Claude tool result also carries the tool's structured output as `structured` (the CLI's `tool_use_result`, opaque and keyed by the tool's name — `EnterWorktree`'s has the `worktreePath` it moved to), and a subagent's tool use and result name the call that started it as `parentToolCallId`. Codex app-server items are mapped to shared names (`commandExecution` → `Bash`, `fileChange` → `Edit`, web page operations → `WebFetch`) and plan notifications become normalized `TodoWrite` snapshots. Background subagents emit replace-in-place snapshots keyed by child thread id; their tool events stay in the parent stream, but their prose is excluded from `onAssistantText` (matching the delta stream). Usage snapshots describe the latest request's context occupancy, never cumulative turn totals; isolated Codex runs report the `codex exec` turn summary, which coincides with occupancy on their single-request metadata turns. The compaction callbacks are described under [Compaction](#compaction). |
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
const all = await updates.checkAll(); // Claude, Codex and agy concurrently
```

Every check reports `current`, `update_available`, `not_installed`, or `unknown`, together with the installed/latest versions and a stable reason when detection is unavailable. Expected command, parsing, and network failures are returned as status data rather than thrown.

Claude detection is intentionally definitive only for native installations. It reads the installation method and `stable` / `latest` channel from `claude doctor`, then compares against that channel at `downloads.claude.ai`; package-manager installations return `unknown` instead of risking a cross-channel false positive. Codex reads the latest version from `codex doctor --json` and accepts its JSON even when unrelated diagnostics make the command exit nonzero. Older Codex versions without update metadata return `unknown`; there is no npm fallback. agy reads its installed version from `agy --version` and the latest from the manifest agy's own auto-updater uses (`antigravity-cli-auto-updater-…run.app/manifests/<platform>.json`), accepting it only when it points at Google's release bucket. A Homebrew install returns `unknown` with `unsupported_installation`, because the cask can lag the manifest.

Checks use five-second command and network timeouts — thirty seconds for `codex doctor --json`, which checks the whole installation, network and database included — and strip the same provider nesting-guard environment variables as agent runs. They never invoke `claude update`, `codex update`, `agy update`, or a package manager, and they do not cache results.

`apply("agy")` runs `agy update` only for an install from the official installer, which puts it at `~/.local/bin/agy`. It refuses a Homebrew install with `unsupported_installation`, pointing at `brew upgrade --cask antigravity-cli`, and refuses any other install with `install_method_unknown`.

### Claude-specific

`model`, `effort`, `appendSystemPrompt` (appended to the Claude Code system prompt; supply it on every run), `permissionMode`, `tools` (`["default"]` is the full set, `[]` disables every built-in), `allowedTools` (pre-approval only), `disallowedTools`, `settingSources`, `settings`, `hooks` (in-process Agent SDK hook callbacks), `strictMcpConfig` (only the MCP servers the session is given; claude.ai connectors are switched off separately, with `settings: { disableClaudeAiConnectors: true }`), `newSessionId` / `resumeSessionId` (mutually exclusive), and `isolated`. `executablePath` is resolved through `PATH` up front, so a missing binary rejects with `MissingCliError`; the SDK's bundled binary is never used.

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

Session settings (model, effort, permission mode, tools, hooks, system prompt, environment) are fixed for the life of the session; open a new one, resuming the same id, to change them. Turns run one at a time. Each prompt is stamped with a uuid, and a turn ends only on a `result` that answers it, so the empty result a resumed CLI writes for a task an earlier process left running is not taken for the turn's own (CLIs that do not echo the uuid fall back to treating an empty result before any output as foreign). A turn whose model started a background subagent stays open past its own `result` until every subagent has reported back and the CLI has answered each notification with a further `result` naming its run — whose text becomes the turn's — or until the CLI has gone `followUpGraceMs` (default 60 s) without a message while that result is due. A notification that lands while the CLI is answering another is waited for in its own right; if the CLI then opens no answer for it within `absorbedFollowUpGraceMs` (default 5 s), the answer before took it in, and the turn ends. A session closes itself — firing `onClose` — when its process exits, after an interrupted (aborted or timed-out) turn, when a turn ends with a background shell or Monitor still running, or when the CLI produces output between turns. A live process would hand a stopped request back to the model with the next prompt, so a stop always ends in a resume from disk; stopping a turn that is only waiting on subagents closes the session at once, since an idle CLI writes no result for the interrupt.

### Codex-specific

Regular Codex turns use the app-server V2 `thread/*` and `turn/*` flow. Options include `developerInstructions`, `resumeSessionId`, `imagePaths`, `model`, `reasoningEffort`, `dangerouslyBypassApprovalsAndSandbox`, `appServerClient`, `appServerSession`, and `isolated`. Images become `localImage` inputs, reasoning effort is sent on `turn/start`, usage streams from `thread/tokenUsage/updated`, and cancellation uses `turn/interrupt`.

`dangerouslyBypassApprovalsAndSandbox` is **off by default**. Enabling it maps to app-server's `approvalPolicy: "never"` and `sandbox: "danger-full-access"`; use it only for trusted prompts in environments you accept the agent can modify.

By default each regular `runCodex` call owns one app-server process. For a thread-bound long-running process, create a `CodexAppServerSession` with `createCodexAppServerSession(...)`; it initializes and starts or resumes the thread once, then its `runTurn(...)` method reuses that thread until the owner calls and awaits `session.close()`. Lower-level hosts can instead create a reusable connection with `createCodexAppServerClient(...)` and pass it as `appServerClient`; a shared client can route concurrent turns by thread and turn id. Native in-turn question and approval requests are not enabled; unsupported server requests receive a JSON-RPC method-not-found response.

An abort or timeout while `turn/start` is still unacknowledged cannot be unwound cleanly: the runner best-effort interrupts the turn when it is identifiable, then retires the app-server process if it owns it (per-turn clients, and sessions — the session reports `closed` and its host starts a fresh one). A borrowed `appServerClient` is never closed, since other threads may be mid-turn on it; its owner should treat the affected thread as suspect and decide the client's lifecycle itself.

For new threads, the runner opts into Codex raw response items so hosted web page operations can retain their resolved URL even when the public `webSearch` completion reports only `action: "other"`. It correlates only a single unambiguous `web__run` invocation, extracts the page-header URL, and discards the raw payload. Ambiguous calls fall back to the ordinary completed item without inventing details. Resumed threads created without raw events still receive correct search/fetch classification and any URL or find pattern present in their completed items.

`isolated: true` remains on `codex exec` because app-server cannot currently reproduce both per-run ignore flags. It uses an ephemeral session, ignores user config and exec-policy rules, and enforces a read-only sandbox. `model` and `reasoningEffort` are honored (effort maps to the `model_reasoning_effort` config override), and usage is reported from the exec turn summary. It cannot resume a thread, set a `serviceTier` or `sandboxPolicy`, or be combined with `dangerouslyBypassApprovalsAndSandbox`.

`forkSessionId` forks an existing thread for a side run on a one-off app-server, not `codex exec`. It sends `thread/fork` with `ephemeral: true`, a read-only sandbox and `approvalPolicy: "never"`. The fork sees the thread's history, including the current turn's completed items, and nothing it does is written back to the thread. With `isolated: true`, it also sends `CODEX_FORK_CONFIG`, which turns off web search and every tool feature, and switches off each configured MCP server by name. If a tool item starts anyway, the run sends `turn/interrupt` and rejects with `CodexTurnError`. Without `isolated`, the fork keeps Codex's tools, and `turn/start` carries your `sandboxPolicy`, which must be `readOnly`. That bounds the fork's shell, not everything it can reach: network access, exec-policy rules that allow a command outside the sandbox, and MCP tools approved in the user's Codex config can still act, exactly as they could in an ordinary read-only turn. A guarded fork's `forkConfig` goes on `thread/fork` as its config overrides, such as an MCP server for that fork alone. A fork cannot be combined with `resumeSessionId`, `appServerClient`, `appServerSession`, `turnCwd`, or `dangerouslyBypassApprovalsAndSandbox`; an isolated one cannot take a `sandboxPolicy` either.

### agy-specific

agy runs over `agy acp`, its [Agent Client Protocol](https://agentclientprotocol.com) server, one process per session. How the runner talks to agy follows [T3 Code](https://github.com/pingdotgg/t3code)'s agy adapter. `runAgy` opens a session, runs one turn and closes it; `createAgySession` keeps the process up between turns, with `runTurn`, `steer`, `compact`, `onClose` and `close` like the other sessions.

Options: `model`, `effort`, `mode`, `appendSystemPrompt`, `mcpServers`, `resumeSessionId`, `dangerouslySkipPermissions`, `isolated`, `geminiDir` and `appDataDir` (agy's `--gemini-dir` and `--app-data-dir`), `authMethod` (default `oauth-personal`), and on a session `onContinuation`, `interruptGraceMs`, `replyQuietMs` and `inactivityTimeoutMs`. A turn can also pass `model`, `effort`, `mode`, `imagePaths` and `onPermissionRequest`.

- **Start.** The runner sends `initialize` and then `authenticate` straight away. It needs agy 1.5.0 or newer. agy prints a sign-in link when it is signed out; the runner catches it, also through a `BROWSER` helper so no browser opens on the host, and rejects with `AgyAuthError` carrying the `url`. Sign in with `agy` or `agy acp --login`. Credentials in `env`, such as `GEMINI_API_KEY`, pass through to agy and decide which account it uses.
- **Model, effort, mode.** These are agy's config options, found by category. A turn's value falls back to the session's, or to what agy picked when the session opened, and the runner only sends a change. `model: "default"` is the model agy opened the session with. An unlisted model rejects with `AgyTurnError` code `model_unavailable`, except a legacy id such as `gemini-3.8-flash-high` whose family is listed. `effort` is agy's thinking level; only Gemini models have one, and other models ignore it. `mode` must be one agy advertises (1.5.13: `default`, `accept-edits`, `auto`, `plan`).
- **Permissions.** agy asks before the tool calls its mode and settings gate. A turn's `onPermissionRequest` answers with an option id, or `"cancel"`. Without a callback the runner picks `reject_once`, as Claude and Codex deny by default. A question agy asks the user (`kind: "question"`) is cancelled. `dangerouslySkipPermissions` answers every approval with `allow_once`, never `allow_always`.
- **Subagents.** agy reports a subagent launch as an `Agent` tool call and never says when the subagent finishes. The runner reads that from agy's own files under `~/.gemini/antigravity-cli/brain/`, as T3 Code does. A turn whose subagents are still working, or that left a non-daemon command running, stays open past agy's `end_turn` until they report back. The replies agy sends by itself are folded into the turn, and the turn's text becomes theirs. agy never says such a reply is over, so the turn ends `replyQuietMs` (default 3 s) after a usage update with no output since, or after 2 minutes of quiet while a reply is still open. A subagent that agy's files still don't show 2 minutes after its launch is reported `failed` and no longer holds the turn. Pass `timeoutMs` to bound such a turn.
- **Output with no turn open.** A finished daemon or a late wake can make agy reply on its own. `onContinuation` receives that as a continuation run. Without it the output is dropped, as Codex does, and permission requests are cancelled.
- **Errors.** agy reports quota and API errors as chat text and a plain `end_turn`. After each prompt the runner reads the steps the prompt added to agy's step log (`conversations/<id>.db`, through `node:sqlite` on Node 22.5+ and Bun) and rejects with `AgyTurnError`: `usage_limit` with `resetAt` for quotas and rate limits, `broken: true` for a conversation agy can no longer send, which also closes the session. Without `node:sqlite`, `session.outcomeSource` is `"stop-reason"` and only a `refusal` stop reason fails a turn. A failed resume rejects; the runner never opens a new session in its place.
- **Isolated.** `isolated: true` runs in a fresh temp folder in `default` mode, cancels every permission request, fails the run on any tool call, and deletes the session's conversation, brain and annotation files and the folder afterwards. agy still starts the MCP servers configured in `~/.gemini/config`.
- **Usage.** Each `usage_update` reports context occupancy and the window; input and output counts are 0 until the prompt answers, then come from its response.

Not supported for agy: forks (`forkSessionId`, lasting forks) and deleting a session, which agy offers only in its TUI; per-session `tools`, `allowedTools`, `disallowedTools`, `settings`, `settingSources` and `hooks`, since `agy acp` takes no `--settings` (use `mode`, `onPermissionRequest` and agy's own settings.json rules); `onMcpStatus` and `onMcpElicitation`; `newSessionId`; `serviceTier`, `sandboxPolicy` and `turnCwd`; reasoning text.

### Provider capabilities

`PROVIDER_CAPABILITIES` states what this library can do with each CLI, so a host can branch on a feature instead of a provider name:

| Capability | claude | codex | agy |
| --- | --- | --- | --- |
| `serviceTiers` | no | yes | no |
| `compactionFocus` | yes | no | yes |
| `sideFork` | yes | yes | no |
| `lastingFork` | yes | yes | no |
| `deleteSession` | yes | no | no |
| `mcpStatus` | yes | yes | no |
| `mcpElicitation` | yes | yes | no |
| `toolHooks` | yes | no | no |
| `permissionCallback` | no | no | yes |
| `readOnlyTurns` | yes | yes | no |
| `images` | no | yes | yes |
| `failedTurn` | `resolves` | `rejects` | `rejects` |

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

`AgySession.compact` sends agy's `/compact`, with the optional `instructions` after it, when agy lists that command. agy sends no compaction event, so `onCompaction` fires when the next usage update shows a smaller context.

In every case the result's `text` is empty, and the compaction can't be steered. `onCompaction` receives `{ trigger, preTokens?, postTokens? }` for a requested compaction and for one the CLI starts on its own mid-turn. After an automatic Claude compaction, a turn reports no size until a later request in it measures one.

`onCompactionStart` receives `{ trigger }` when the CLI begins compacting, so a host can show the work before it ends. `trigger` is `manual` for a `compact()` turn and `auto` otherwise. Claude Code reports the start as a `status` line with `status: "compacting"`, and Codex as `item/started` for a `contextCompaction` item. Each attempt ends in one of three ways. `onCompaction` fires when it succeeds. `onCompactionFailed` receives `{ trigger, error? }` when Claude Code closes it without compacting: with `compact_result: "failed"`, or with no result at all, as when a PreCompact hook blocks it. The turn may go on after that. Claude Code closes an attempt before it writes the boundary, so a success arrives as `onCompaction` just after. Codex reports no failed compaction of its own, so a Codex attempt that fails ends when its turn settles, with the turn's error. A host that tracks an open attempt should close it when the turn settles too. Subagents' compactions are ignored.

### Lasting forks

A run's `forkSessionId` makes a throwaway copy. To copy a conversation that a new session carries on from, fork it without running a turn:

```ts
const claudeCopy = await forkClaudeSession(sessionId, { cwd });
const codexCopy = await forkCodexThread({ threadId, cwd, executablePath, timeoutMs, signal });
```

Each answers the copy's id, which `resumeSessionId` then continues; later turns on the original and the copy don't see each other. `forkClaudeSession` copies the session file under new ids with the SDK's `forkSession`, reading and writing where the CLI keeps sessions for `cwd` (under this process's `CLAUDE_CONFIG_DIR`, or the default). `deleteClaudeSession(sessionId, { cwd })` deletes one, such as a copy nothing took up. `forkCodexThread` starts a one-shot app-server, sends `thread/fork` with `ephemeral: false`, and closes the app-server however the fork ends. `timeoutMs` (default 60 s) bounds the whole fork; an abort rejects with `AbortError`. Codex has no call that deletes a thread.

### Errors

`AbortError`, `TimeoutError`, `MissingCliError` (ENOENT; carries `.cli`), `SteerRejectedError`, and the turn errors below.

`ProviderTurnError` is the base of every provider's turn error. It carries `provider`, `kind` (`usage_limit`, `provider_error`, `auth_required`, `unsupported` or `invalid_request`), `retryable`, `resetAt`, `code` and `exitCode`, so a host can handle every failure in one place:

- `CodexTurnError`: fatal Codex turn notifications, `kind: "provider_error"`. Isolated exec failures also carry `.exitCode`.
- `AgyTurnError`: a failed agy turn or a request the session refused, with `stopReason`, `broken` and the turn's last `text`.
- `AgyAuthError`: agy needs the user to sign in, `kind: "auth_required"`, with the sign-in `url` when agy printed one.

A failed Claude turn does not reject: it resolves with `exitCode: 1`, as `PROVIDER_CAPABILITIES.claude.failedTurn` states.

## Develop

```sh
pnpm install
pnpm test        # vitest
pnpm typecheck
pnpm build       # tsup → dist/ (commit the result), then checks the bundle kept node:sqlite
AGY_LIVE=1 node scripts/agy-live-smoke.mjs  # opt-in smoke test against the installed agy
```

## License

MIT
