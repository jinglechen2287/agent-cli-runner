import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Writes agy's brain/ records the way agy 1.5 does, under a data root. */
export function writeSubagent(root: string, parent: string, child: string, fields: { role?: string; typeName?: string; state?: string } = {}): void {
  const dir = join(root, "brain", parent, ".system_generated", "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${child}.json`), JSON.stringify({
    conversationId: child,
    subagentDescriptor: { typeName: fields.typeName ?? "self", role: fields.role ?? "Worker" },
    state: fields.state ?? "SUBAGENT_STATE_ALIVE",
    spawnStepIndex: 3,
  }));
}

export function writeLaunchMessage(root: string, parent: string, child: string, toolCallId: string, timestamp?: string): void {
  const dir = join(root, "brain", child, ".system_generated", "messages");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `launch-${child}-${toolCallId}.json`), JSON.stringify({
    id: `launch-${child}-${toolCallId}`,
    recipient: child,
    sender: parent,
    ...(timestamp ? { timestamp } : {}),
    content: "do the work",
    sourceMetadata: { tool: { conversationId: parent, stepIndex: 3, toolCall: { id: toolCallId, name: "invoke_subagent" } } },
  }));
  writeFileSync(join(dir, "read.json"), "{}");
}

export function writeReport(root: string, parent: string, child: string, id: string, content: string, timestamp: string): void {
  const dir = join(root, "brain", parent, ".system_generated", "messages");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, recipient: parent, sender: child, timestamp, content }));
  writeFileSync(join(dir, "read.json"), JSON.stringify({ [id]: true }));
}

/** agy's notice, from "system", that a child stopped without a report of its own. */
export function writeIdleNotice(root: string, parent: string, child: string, id: string, response: string, timestamp: string): void {
  const dir = join(root, "brain", parent, ".system_generated", "messages");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    id,
    recipient: parent,
    sender: "system",
    priority: "MESSAGE_PRIORITY_LOW",
    timestamp,
    hideFromUser: true,
    content: `Subagent ${child} has gone idle. This was the subagent's most recent response: ${response}`,
  }));
}
