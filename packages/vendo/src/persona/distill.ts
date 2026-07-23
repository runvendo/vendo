import {
  isReservedSubject,
  VendoError,
  type AuditEvent,
  type StoreAdapter,
  type VendoRecord,
} from "@vendoai/core";
import { emptyPersona, loadPersona, mergeFacts, savePersona } from "./store.js";
import type { Persona, PersonaFact, PersonaFactKind } from "./types.js";

/** What a distill pass saw, before it is turned into facts and a summary. A
 *  caller (the eval, or a host that wants a model-authored summary) can read
 *  this to shape its own summary via `DistillOptions.summarize`. */
export interface DistillDigest {
  subject: string;
  threads: number;
  auditEvents: number;
  topTools: { tool: string; count: number }[];
  formatCues: { phrase: string; kind: PersonaFactKind; count: number }[];
  userAsks: string[];
}

export interface DistillOptions {
  /** Cap the history scanned so distillation stays bounded on a heavy user. */
  maxThreads?: number;
  maxAuditEvents?: number;
  /** Optional override for the summary paragraph. Default is a deterministic
   *  render of the facts, so the feature carries no model dependency; a host or
   *  the eval can pass a model-backed summarizer for a richer paragraph. */
  summarize?: (digest: DistillDigest) => Promise<string>;
}

/** Format and preference cues we can read straight from a user's own words,
 *  deterministically. Deliberately small and honest: this is keyword evidence,
 *  not language understanding. */
const FORMAT_CUES: { term: string; kind: PersonaFactKind; phrase: string }[] = [
  { term: "table", kind: "format", phrase: "Often asks for results as a table" },
  { term: "csv", kind: "format", phrase: "Often asks for CSV output" },
  { term: "chart", kind: "format", phrase: "Often asks for charts" },
  { term: "graph", kind: "format", phrase: "Often asks for charts" },
  { term: "list", kind: "format", phrase: "Often asks for a list" },
  { term: "summary", kind: "preference", phrase: "Prefers summarized answers" },
  { term: "brief", kind: "preference", phrase: "Prefers brief answers" },
  { term: "detailed", kind: "preference", phrase: "Prefers detailed answers" },
];

const listAllBySubject = async (
  store: StoreAdapter,
  collection: string,
  subject: string,
  cap: number,
): Promise<VendoRecord[]> => {
  const out: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const remaining = cap - out.length;
    const page = await store.records(collection).list({
      refs: { subject },
      limit: Math.min(100, remaining),
      ...(cursor === undefined ? {} : { cursor }),
    });
    out.push(...page.records);
    cursor = page.cursor;
  } while (cursor !== undefined && out.length < cap);
  return out.slice(0, cap);
};

/** Pull the user's own text out of a thread's messages, mirroring the agent's
 *  own defensive walk (role === "user", part.type === "text"). */
const userTexts = (data: unknown): string[] => {
  if (data === null || typeof data !== "object") return [];
  const messages = (data as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  const texts: string[] = [];
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    if ((message as { role?: unknown }).role !== "user") continue;
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (
        part !== null &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        const text = (part as { text: string }).text.trim();
        if (text !== "") texts.push(text);
      }
    }
  }
  return texts;
};

const countTools = (rows: VendoRecord[]): { tool: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const event = row.data as Partial<AuditEvent> | null;
    if (event?.kind !== "tool-call") continue;
    if (typeof event.tool !== "string" || event.tool === "") continue;
    counts.set(event.tool, (counts.get(event.tool) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => (b.count === a.count ? a.tool.localeCompare(b.tool) : b.count - a.count));
};

const scanFormatCues = (
  asks: string[],
): { phrase: string; kind: PersonaFactKind; count: number }[] => {
  const lowered = asks.map((ask) => ask.toLowerCase());
  const threshold = Math.max(2, Math.ceil(asks.length * 0.2));
  const byPhrase = new Map<string, { phrase: string; kind: PersonaFactKind; count: number }>();
  for (const cue of FORMAT_CUES) {
    const count = lowered.filter((ask) => ask.includes(cue.term)).length;
    if (count < threshold) continue;
    const existing = byPhrase.get(cue.phrase);
    // chart/graph collapse onto one phrase — keep the larger evidence count.
    if (existing === undefined || count > existing.count) {
      byPhrase.set(cue.phrase, { phrase: cue.phrase, kind: cue.kind, count });
    }
  }
  return [...byPhrase.values()].sort((a, b) => b.count - a.count);
};

/** Facts carry STABLE text (so re-distilling dedupes cleanly) and put the volatile
 *  counts in `evidence`. */
const buildFacts = (
  digest: DistillDigest,
  at: string,
): PersonaFact[] => {
  const facts: PersonaFact[] = [];
  if (digest.topTools.length > 0) {
    const names = digest.topTools.slice(0, 3).map((entry) => entry.tool);
    facts.push({
      kind: "workflow",
      text: `Reaches for ${names.join(", ")}`,
      evidence: `top tools by usage across ${digest.auditEvents} audited actions`,
      updatedAt: at,
    });
  }
  for (const cue of digest.formatCues) {
    facts.push({
      kind: cue.kind,
      text: cue.phrase,
      evidence: `seen in ${cue.count} of ${digest.userAsks.length} recent requests`,
      updatedAt: at,
    });
  }
  return facts;
};

const defaultSummary = (digest: DistillDigest, facts: PersonaFact[]): string => {
  if (facts.length === 0) return "";
  const parts: string[] = [];
  if (digest.topTools.length > 0) {
    parts.push(`Reaches for ${digest.topTools.slice(0, 3).map((entry) => entry.tool).join(", ")}.`);
  }
  const shape = facts
    .filter((fact) => fact.kind === "format" || fact.kind === "preference")
    .map((fact) => fact.text);
  if (shape.length > 0) parts.push(`${shape.join(". ")}.`);
  return parts.join(" ");
};

/** Build or refresh a subject's persona from their own threads and audit trail.
 *  Deterministic by default. Merges distilled facts into any existing record
 *  (including facts the agent remembered mid-turn), keeping the record bounded. */
export const distillPersona = async (
  store: StoreAdapter,
  subject: string,
  options: DistillOptions = {},
): Promise<Persona> => {
  if (isReservedSubject(subject)) {
    throw new VendoError("validation", "cannot distill a persona for a reserved subject");
  }
  const maxThreads = options.maxThreads ?? 100;
  const maxAudit = options.maxAuditEvents ?? 500;

  const threadRows = await listAllBySubject(store, "vendo_threads", subject, maxThreads);
  const userAsks: string[] = [];
  for (const row of threadRows) {
    // list() may omit message bodies once a thread has a stored title; re-read
    // the full row so we always distill from the real conversation.
    const full = await store.records("vendo_threads").get(row.id);
    userAsks.push(...userTexts(full?.data ?? row.data));
  }

  const auditRows = await listAllBySubject(store, "vendo_audit", subject, maxAudit);
  const topTools = countTools(auditRows);
  const formatCues = scanFormatCues(userAsks);

  const digest: DistillDigest = {
    subject,
    threads: threadRows.length,
    auditEvents: auditRows.length,
    topTools,
    formatCues,
    userAsks,
  };
  const at = new Date().toISOString();
  const facts = buildFacts(digest, at);
  const summary = options.summarize ? await options.summarize(digest) : defaultSummary(digest, facts);

  const base = (await loadPersona(store, subject)) ?? emptyPersona(subject);
  return savePersona(store, {
    ...base,
    summary,
    facts: mergeFacts(base.facts, facts),
    distilledFrom: { threads: threadRows.length, auditEvents: auditRows.length },
  });
};
