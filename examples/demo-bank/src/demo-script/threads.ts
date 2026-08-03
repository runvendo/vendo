/**
 * Minimal thread persistence for scripted turns — reads and writes the SAME
 * reserved `vendo_threads` rows the real agent's ThreadRepository uses, so
 * scripted history is indistinguishable from agent history: it lists, reopens,
 * and resumes through the ordinary wire. Access rides the PUBLIC records door
 * (`store.records("vendo_threads")` — reserved-collection routing every
 * VendoStore implements), so scripted turns behave identically on the local
 * PGlite store and the Cloud hosted store.
 */
import type { Json, Principal, ThreadId } from "@vendoai/core";
import type { UIMessage } from "ai";
import { vendo } from "@/vendo/server";

export interface ScriptedThread {
  id: ThreadId;
  messages: UIMessage[];
}

function mintThreadId(): ThreadId {
  // Same shape the agent mints (03-agent §5).
  return `thr_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

/** Load (or mint) the thread for this turn, scoped to the caller's subject. */
export async function loadScriptedThread(
  principal: Principal,
  threadId: string | undefined,
): Promise<ScriptedThread> {
  if (threadId === undefined) return { id: mintThreadId(), messages: [] };
  const record = await vendo.store.records("vendo_threads").get(threadId);
  // The records door gets by id alone; the subject guard threadStore applied
  // lives here instead — a foreign thread reads as absent, never as history.
  const data = record?.data as { subject?: string; messages?: Json[] } | undefined;
  if (record === null || data?.subject !== principal.subject) {
    return { id: threadId as ThreadId, messages: [] };
  }
  return { id: record.id as ThreadId, messages: (data.messages ?? []) as unknown as UIMessage[] };
}

/** Upsert by message id — the same identity rule the agent applies. */
export function upsertMessage(messages: UIMessage[], message: UIMessage): void {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index === -1) messages.push(message);
  else messages[index] = message;
}

/** Persist the finished turn (plain-JSON serialize drops explicit undefineds
 *  exactly like the agent's persist path). */
export async function persistScriptedThread(
  principal: Principal,
  id: ThreadId,
  messages: UIMessage[],
): Promise<void> {
  const plain = JSON.parse(JSON.stringify(messages)) as Json[];
  await vendo.store.records("vendo_threads").put({
    id,
    data: { subject: principal.subject, messages: plain },
  });
}
