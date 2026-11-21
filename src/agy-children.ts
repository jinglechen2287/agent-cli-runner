/**
 * agy reports a subagent launch as an ordinary tool call and never says when
 * the subagent finishes. It does record both on disk, under its brain/ tree:
 * the subagent's record, the launch message in the subagent's inbox, and the
 * subagent's reports in the parent's inbox, or agy's notice there that the
 * subagent went idle. Ported from T3 Code's
 * AntigravityChildWork (agy 1.5 layout).
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { isAgyId, literalPath } from "./agy-paths.js";
import { isRecord } from "./internal.js";

const MAX_FILES = 256;
const MAX_FILE_BYTES = 1024 * 1024;

export interface AgyChildState {
  childId: string;
  role?: string;
  typeName?: string;
  /** `reported`: the subagent has sent the parent at least one message. */
  state: "running" | "reported" | "killed";
  /** The subagent's newest report. */
  summary?: string;
  reportedAt?: number;
}

/** The newest `limit` JSON records in `dir`, `MAX_FILES` unless given: a session's inbox only grows, and the reports that matter are the latest ones. */
async function readJsonFiles(dir: string | undefined, limit = MAX_FILES): Promise<Array<Record<string, unknown>>> {
  if (!dir) return [];
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json") && name !== "read.json");
  } catch {
    return [];
  }
  const files: Array<{ path: string; modified: number; size: number }> = [];
  for (const name of names) {
    const path = await literalPath(dir, [name]);
    if (!path) continue;
    try {
      const info = await stat(path);
      if (info.isFile()) files.push({ path, modified: info.mtimeMs, size: info.size });
    } catch {
      // Gone between the listing and the stat.
    }
  }
  files.sort((a, b) => b.modified - a.modified);
  const records: Array<Record<string, unknown>> = [];
  for (const { path, size } of files.slice(0, limit)) {
    if (size > MAX_FILE_BYTES) continue;
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (isRecord(value)) records.push(value);
    } catch {
      // A record agy is still writing, or one it never finished: skip it.
    }
  }
  return records;
}

function generatedDir(root: string, conversationId: string, leaf: "subagents" | "messages") {
  return literalPath(root, ["brain", conversationId, ".system_generated", leaf]);
}

function timeOf(message: Record<string, unknown>): number {
  return typeof message.timestamp === "string" ? Date.parse(message.timestamp) : Number.NaN;
}

/** What `childId` reported in a parent-inbox message, if it is a report:
 * the child's own message, or agy's notice that the child went idle, which
 * quotes the child's last response. agy 1.5.13 sends either. */
function reportFrom(message: Record<string, unknown>, childId: string): { content: string; notice: boolean } | undefined {
  if (typeof message.content !== "string") return undefined;
  if (message.sender === childId) return { content: message.content, notice: false };
  if (message.sender !== "system") return undefined;
  const idle = `Subagent ${childId} has gone idle.`;
  if (!message.content.startsWith(idle)) return undefined;
  const quoted = message.content.slice(idle.length).replace(/^\s*This was the subagent's most recent response:\s*/, "");
  return { content: quoted.trim(), notice: true };
}

function launchToolCallId(message: Record<string, unknown>): string | undefined {
  const tool = isRecord(message.sourceMetadata) ? message.sourceMetadata.tool : undefined;
  const toolCall = isRecord(tool) ? tool.toolCall : undefined;
  return isRecord(toolCall) && typeof toolCall.id === "string" ? toolCall.id : undefined;
}

/** Every conversation `sessionId` launched as a subagent, as agy's own records
 * name them. Fails soft: anything unreadable names no child. */
export async function listAgyChildIds(root: string, sessionId: string): Promise<string[]> {
  if (!isAgyId(sessionId)) return [];
  // Every one, not the newest few: a child left out would keep its files after its parent's are gone.
  const records = await readJsonFiles(await generatedDir(root, sessionId, "subagents"), Number.POSITIVE_INFINITY);
  return [...new Set(records.flatMap((record) => typeof record.conversationId === "string" && isAgyId(record.conversationId) ? [record.conversationId] : []))];
}

/** The subagents `rootSessionId` launched through the tool calls in
 * `launches`, keyed by that tool call id. Fails soft: anything unreadable is
 * left out. */
export async function readAgyChildren(
  root: string,
  rootSessionId: string,
  launches: readonly string[],
): Promise<Map<string, AgyChildState>> {
  const children = new Map<string, AgyChildState>();
  if (!isAgyId(rootSessionId) || launches.length === 0) return children;
  const wanted = new Set(launches);
  const records = await readJsonFiles(await generatedDir(root, rootSessionId, "subagents"));
  if (records.length === 0) return children;
  const parentInbox = await readJsonFiles(await generatedDir(root, rootSessionId, "messages"));

  for (const record of records) {
    const childId = record.conversationId;
    if (typeof childId !== "string" || !isAgyId(childId)) continue;
    const childInbox = await readJsonFiles(await generatedDir(root, childId, "messages"));
    // One child can be launched again: each launch owns the reports sent
    // from its own message up to the next launch.
    const launchesOfChild = childInbox
      .filter((message) => message.sender === rootSessionId)
      .flatMap((message) => {
        const toolCallId = launchToolCallId(message);
        return toolCallId ? [{ toolCallId, at: timeOf(message) }] : [];
      })
      .sort((a, b) => (Number.isNaN(a.at) ? 0 : a.at) - (Number.isNaN(b.at) ? 0 : b.at));
    if (!launchesOfChild.some((launch) => wanted.has(launch.toolCallId))) continue;

    const descriptor = isRecord(record.subagentDescriptor) ? record.subagentDescriptor : {};
    const reports = parentInbox
      .flatMap((message) => {
        const report = reportFrom(message, childId);
        return report ? [{ ...report, at: timeOf(message) }] : [];
      })
      .sort((a, b) => (Number.isNaN(a.at) ? 0 : a.at) - (Number.isNaN(b.at) ? 0 : b.at));
    const killed = record.state === "SUBAGENT_STATE_KILLED";
    launchesOfChild.forEach((launch, index) => {
      if (!wanted.has(launch.toolCallId)) return;
      const next = launchesOfChild[index + 1]?.at;
      const own = reports.filter((report) =>
        (Number.isNaN(launch.at) || Number.isNaN(report.at) || report.at >= launch.at)
        && (next === undefined || Number.isNaN(next) || Number.isNaN(report.at) || report.at < next));
      // The child's own words win; agy's idle notice stands in without them.
      const newest = own.filter((report) => !report.notice).at(-1) ?? own.at(-1);
      // A kill applies to the child's newest launch.
      const state: AgyChildState["state"] = killed && next === undefined
        ? "killed"
        : newest ? "reported" : "running";
      children.set(launch.toolCallId, {
        childId,
        ...(typeof descriptor.role === "string" ? { role: descriptor.role } : {}),
        ...(typeof descriptor.typeName === "string" ? { typeName: descriptor.typeName } : {}),
        state,
        ...(newest ? { summary: newest.content } : {}),
        ...(newest && !Number.isNaN(newest.at) ? { reportedAt: newest.at } : {}),
      });
    });
  }
  return children;
}
