// Opt-in smoke test against the installed agy: AGY_LIVE=1 node scripts/agy-live-smoke.mjs
// (or `bun scripts/agy-live-smoke.mjs`). Uses the built dist/, spends agy
// quota, and runs in fresh temp folders with agy's default permission mode,
// so every tool permission agy asks for is denied. Step S30 calls
// apply("agy"), which runs `agy update` on a native install: skip it with
// AGY_ONLY if you don't want your agy upgraded.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbortError,
  AgyTurnError,
  createAgySession,
  createModelCatalogService,
  createProviderUpdateService,
  runAgy,
} from "../dist/index.js";

if (process.env.AGY_LIVE !== "1") {
  console.log("Set AGY_LIVE=1 to run the live agy smoke test.");
  process.exit(0);
}

const only = new Set((process.env.AGY_ONLY ?? "").split(",").filter(Boolean));
const results = [];
const cwd = mkdtempSync(join(tmpdir(), "agy-smoke-"));
const conversations = join(homedir(), ".gemini", "antigravity-cli", "conversations");
const count = () => readdirSync(conversations).length;

async function step(id, run) {
  if (only.size && !only.has(id)) return;
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ id, ok: true, ms: Date.now() - started, detail });
    console.log(`PASS ${id} (${Date.now() - started} ms)`, JSON.stringify(detail));
  } catch (error) {
    results.push({ id, ok: false, error: String(error?.stack ?? error) });
    console.log(`FAIL ${id}`, error?.name, error?.message, error?.code ?? "");
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let firstSession;

await step("S3", async () => {
  const ids = [];
  const result = await runAgy({ prompt: "Reply with the single word PONG and nothing else.", cwd, onSessionId: (id) => ids.push(id) });
  assert(/PONG/.test(result.text), `text was ${JSON.stringify(result.text)}`);
  assert(result.exitCode === 0 && result.sessionId && ids[0] === result.sessionId, "missing session id");
  assert(result.usage?.contextWindow > 0 && result.usage.contextTokens > 0, "missing usage");
  return { text: result.text.trim(), sessionId: result.sessionId, usage: result.usage };
});

await step("S6", async () => {
  const session = await createAgySession({ cwd, appendSystemPrompt: "The secret word is PELICAN-42. When asked for the secret word, reply with only it." });
  try {
    const result = await session.runTurn({ prompt: "What is the secret word?" });
    assert(result.text.includes("PELICAN-42"), `text was ${JSON.stringify(result.text)}`);
    firstSession = session.sessionId;
    return { text: result.text.trim(), outcomeSource: session.outcomeSource };
  } finally {
    await session.close();
  }
});

await step("S7", async () => {
  const error = await createAgySession({ cwd, resumeSessionId: "00000000-0000-4000-8000-000000000000" }).then(
    async (session) => { await session.close(); return undefined; },
    (caught) => caught,
  );
  assert(error instanceof AgyTurnError, `expected AgyTurnError, got ${error?.name}: ${error?.message}`);
  if (firstSession) {
    const resumed = await createAgySession({ cwd, resumeSessionId: firstSession, appendSystemPrompt: "The secret word is PELICAN-42." });
    try {
      const result = await resumed.runTurn({ prompt: "Repeat the secret word once more." });
      assert(result.text.includes("PELICAN-42"), `resumed text was ${JSON.stringify(result.text)}`);
    } finally {
      await resumed.close();
    }
  }
  return { rejected: error.name, code: error.code };
});

await step("S8", async () => {
  const session = await createAgySession({ cwd, mode: "default" });
  try {
    const one = await session.runTurn({ prompt: "Reply with OK.", effort: "low", mode: "plan" });
    const two = await session.runTurn({ prompt: "Reply with OK again." });
    return { one: one.text.trim().slice(0, 40), two: two.text.trim().slice(0, 40) };
  } finally {
    await session.close();
  }
});

await step("S14", async () => {
  const session = await createAgySession({ cwd });
  try {
    const turn = session.runTurn({ prompt: "Count from 1 to 120, one number per line, then stop." });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await session.steer({ prompt: "Also end your final answer with the word BANANA." });
    const result = await turn;
    assert(/BANANA/.test(result.text), `text tail was ${JSON.stringify(result.text.slice(-120))}`);
    return { tail: result.text.trim().slice(-60) };
  } finally {
    await session.close();
  }
});

await step("S19", async () => {
  const session = await createAgySession({ cwd });
  const agents = new Map();
  try {
    // Gemini can think for a minute before launching, and each subagent takes
    // as long again, so the budget is generous; on timeout, say what was open.
    const result = await session.runTurn({
      prompt: "Start two background subagents with invoke_subagent, both at once and without tools: subagent A writes a haiku about rivers, subagent B writes a haiku about mountains. Each reports its haiku back. Do not wait for them: end your turn now saying only STARTED. When each reports, repeat its haiku.",
      timeoutMs: 420_000,
      onBackgroundAgentUpdate: (info) => agents.set(info.id, info),
    }).catch((error) => {
      throw new Error(`${error.message}; subagents: ${JSON.stringify([...agents.values()].map((info) => info.status))}`);
    });
    const states = [...agents.values()].map((info) => ({ description: info.description, status: info.status, summary: info.summary?.slice(0, 50) }));
    assert(agents.size >= 1, "no subagent was reported");
    assert(states.every((state) => state.status === "completed"), `subagents still ${JSON.stringify(states)}`);
    return { text: result.text.trim().slice(0, 120), agents: states };
  } finally {
    await session.close();
  }
});

await step("S20", async () => {
  const session = await createAgySession({ cwd });
  const agents = new Map();
  try {
    const result = await session.runTurn({
      prompt: "Use invoke_subagent to have a subagent write one sentence about the sea, without tools. Wait for its answer inside this turn, then reply with that sentence.",
      timeoutMs: 420_000,
      onBackgroundAgentUpdate: (info) => agents.set(info.id, info),
    });
    return { text: result.text.trim().slice(0, 120), agents: [...agents.values()].map((info) => info.status) };
  } finally {
    await session.close();
  }
});

await step("S23", async () => {
  const session = await createAgySession({ cwd });
  try {
    const controller = new AbortController();
    const turn = session.runTurn({ prompt: "Count slowly from 1 to 500, one number per line.", signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    controller.abort();
    const error = await turn.then(() => undefined, (caught) => caught);
    assert(error instanceof AbortError, `expected AbortError, got ${error?.name}`);
    assert(!session.closed, "session closed after a clean cancel");
    const next = await session.runTurn({ prompt: "Reply with READY." });
    assert(/READY/.test(next.text), `next text ${JSON.stringify(next.text)}`);
    return { aborted: error.name, next: next.text.trim() };
  } finally {
    await session.close();
  }
});

await step("S26", async () => {
  const session = await createAgySession({ cwd });
  try {
    await session.runTurn({ prompt: "Write four sentences about rivers." });
    const compactions = [];
    const result = await session.compact({ instructions: "keep only the topic", onCompaction: (info) => compactions.push(info) });
    assert(result.text === "", `compact text ${JSON.stringify(result.text)}`);
    return { compactions, usage: result.usage };
  } finally {
    await session.close();
  }
});

await step("S27", async () => {
  const before = count();
  const result = await runAgy({ prompt: "Give a three-word title for a chat about rivers. Reply with the title only.", cwd, isolated: true });
  const after = count();
  assert(after === before, `conversations went from ${before} to ${after}`);
  return { title: result.text.trim(), conversations: { before, after } };
});

await step("S29", async () => {
  const catalog = await createModelCatalogService().getCatalog("agy", cwd);
  assert(catalog.models[0]?.id === "default" && catalog.models[0].isDefault, "default entry missing");
  return catalog.models.map((model) => `${model.id}[${model.efforts.map((effort) => effort.id).join("/")}]`);
});

await step("S30", async () => {
  const service = createProviderUpdateService();
  const status = await service.check("agy");
  const applied = await service.apply("agy");
  return { status, applied: { ok: applied.ok, reason: applied.reason, error: applied.error } };
});

rmSync(cwd, { recursive: true, force: true });
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} live steps passed`);
process.exit(failed.length ? 1 : 0);
