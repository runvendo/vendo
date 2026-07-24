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

const now = (): string => new Date().toISOString();

const assertRealSubject = (subject: string): void => {
  if (subject.trim() === "") {
    throw new VendoError("validation", "subject must be a non-empty string");
  }
  if (isReservedSubject(subject)) {
    throw new VendoError("validation", "persona is not tracked for reserved subjects");
  }
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
  if (record === null) return null;
  const parsed = personaSchema.safeParse(record.data);
  return parsed.success ? parsed.data : null;
};

/** Validate, stamp, and persist. `refs.subject` is set so a host can join the
 *  row against its own tables the same way every other Vendo row is joinable. */
export const savePersona = async (
  store: StoreAdapter,
  persona: Persona,
): Promise<Persona> => {
  assertRealSubject(persona.subject);
  const next = personaSchema.parse({
    ...persona,
    facts: persona.facts.slice(0, MAX_PERSONA_FACTS),
    updatedAt: now(),
  });
  await store.records(PERSONA_COLLECTION).put({
    id: next.subject,
    data: next as unknown as Json,
    refs: { subject: next.subject },
  });
  return next;
};

/** Append one durable fact, merging into the existing record (or a fresh one). */
export const rememberFact = async (
  store: StoreAdapter,
  subject: string,
  fact: { kind: PersonaFactKind; text: string; evidence?: string },
): Promise<Persona> => {
  const existing = (await loadPersona(store, subject)) ?? emptyPersona(subject);
  const merged = mergeFacts(existing.facts, [{ ...fact, updatedAt: now() }]);
  return savePersona(store, { ...existing, facts: merged });
};
