import { isReservedSubject, VendoError, type Json, type StoreAdapter } from "@vendoai/core";
import {
  PERSONA_FORMAT,
  personaSchema,
  type Persona,
  type PersonaFact,
  type PersonaFactKind,
} from "./types.js";

/** Generic, non-reserved `vendo_records` collection. Going straight to the
 *  StoreAdapter (not the app-scoped AppDataAccess) is deliberate: a persona is
 *  keyed by subject, not owned by an app. The name must not collide with the
 *  umbrella's reserved collections (vendo_state, vendo_apps, vendo_threads, ...). */
export const PERSONA_COLLECTION = "persona";

/** A persona is a compact model, not a log. Keep the most recent facts and drop
 *  the tail so one row can never grow without bound. */
export const MAX_PERSONA_FACTS = 50;

/** How many times a guarded write re-reads and re-applies after losing the CAS
 *  race, before giving up. Mirrors thread persistence (03 §5). */
const MAX_WRITE_ATTEMPTS = 5;

const now = (): string => new Date().toISOString();

const assertRealSubject = (subject: string): void => {
  if (subject.trim() === "") {
    throw new VendoError("validation", "subject must be a non-empty string");
  }
  if (isReservedSubject(subject)) {
    throw new VendoError("validation", "persona is not tracked for reserved subjects");
  }
};

const parsePersona = (data: Json): Persona | null => {
  const parsed = personaSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
};

const factKey = (fact: { kind: PersonaFactKind; text: string }): string =>
  `${fact.kind}::${fact.text.trim().toLowerCase()}`;

/** Dedupe by (kind, normalized text) with newest winning, then keep the most
 *  recently updated MAX_PERSONA_FACTS. Deterministic, no clock inside. */
export const mergeFacts = (existing: PersonaFact[], incoming: PersonaFact[]): PersonaFact[] => {
  const byKey = new Map<string, PersonaFact>();
  for (const fact of existing) byKey.set(factKey(fact), fact);
  for (const fact of incoming) byKey.set(factKey(fact), fact);
  return [...byKey.values()]
    .sort((a, b) => (a.updatedAt === b.updatedAt ? 0 : a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, MAX_PERSONA_FACTS);
};

export const emptyPersona = (subject: string): Persona => ({
  format: PERSONA_FORMAT,
  subject,
  summary: "",
  facts: [],
  distilledFrom: { threads: 0, auditEvents: 0 },
  updatedAt: now(),
});

/** Read a subject's persona, or null when none exists. A malformed or older-shape
 *  row is tolerated as null rather than thrown: a persona miss must never break a
 *  live turn, it just means the agent runs stock this time. */
export const loadPersona = async (
  store: StoreAdapter,
  subject: string,
): Promise<Persona | null> => {
  assertRealSubject(subject);
  const record = await store.records(PERSONA_COLLECTION).get(subject);
  return record === null ? null : parsePersona(record.data);
};

/** The one write path: a bounded-retry, revision-guarded read-modify-write, so
 *  two concurrent persona writers can never lose an update. Mirrors thread
 *  persistence exactly (threads.ts, 02-store §4): insert-if-absent for a first
 *  write, revision CAS for an existing row, and an adapter that omits `atomic`
 *  fails closed rather than risking a blind overwrite. `mutate` receives the
 *  current persona (or null) and returns the next one; it is re-run on each
 *  attempt against the freshly re-read row, so the merge is never lost. */
export const mutatePersona = async (
  store: StoreAdapter,
  subject: string,
  mutate: (current: Persona | null) => Persona,
): Promise<Persona> => {
  assertRealSubject(subject);
  const records = store.records(PERSONA_COLLECTION);
  const atomic = records.atomic;
  if (atomic === undefined) {
    throw new VendoError(
      "not-implemented",
      "persona writes need a store with atomic record claims (02-store §4); this adapter omits the capability",
    );
  }
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const record = await records.get(subject);
    const current = record === null ? null : parsePersona(record.data);
    const draft = mutate(current);
    const next = personaSchema.parse({
      ...draft,
      subject,
      facts: draft.facts.slice(0, MAX_PERSONA_FACTS),
      updatedAt: now(),
    });
    const input = { id: subject, data: next as unknown as Json, refs: { subject } };
    const written = record === null
      ? await atomic.insertIfAbsent(input)
      : await atomic.compareAndSwap(input, record.revision!);
    if (written !== null) return next;
  }
  throw new VendoError(
    "conflict",
    `persona ${subject} write lost the update race ${MAX_WRITE_ATTEMPTS} times`,
  );
};

/** Validate and persist a full persona, replacing whatever is there. Atomic like
 *  every write, but a deliberate blind set (used for seeding and tests), not a
 *  merge. Prefer `rememberFact` / `distillPersona` for incremental updates. */
export const savePersona = async (store: StoreAdapter, persona: Persona): Promise<Persona> =>
  mutatePersona(store, persona.subject, () => persona);

/** Append one durable fact, merging into the existing record (or a fresh one),
 *  concurrency-safe. */
export const rememberFact = async (
  store: StoreAdapter,
  subject: string,
  fact: { kind: PersonaFactKind; text: string; evidence?: string },
): Promise<Persona> =>
  mutatePersona(store, subject, (current) => {
    const base = current ?? emptyPersona(subject);
    return { ...base, facts: mergeFacts(base.facts, [{ ...fact, updatedAt: now() }]) };
  });
