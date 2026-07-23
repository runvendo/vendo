import { z } from "zod";
import { isoDateTimeSchema, type IsoDateTime } from "@vendoai/core";

/** Format tag on the persisted persona record, so a future shape can be
 *  introduced without breaking readers (the contracts' own evolution rule for
 *  self-describing documents). */
export const PERSONA_FORMAT = "vendo/persona@1";

/** The five things worth knowing about a user of an agent product: what they are
 *  trying to do (workflow, domain), how they want it back (format), what they
 *  have told us to always do (preference), and how much they want to be asked
 *  before a write happens (approval-posture). A closed set now, additive later
 *  the same way the contracts grow binding kinds and trigger kinds. */
export type PersonaFactKind =
  | "workflow"
  | "format"
  | "domain"
  | "preference"
  | "approval-posture";

export const personaFactKindSchema = z.enum([
  "workflow",
  "format",
  "domain",
  "preference",
  "approval-posture",
]) satisfies z.ZodType<PersonaFactKind>;

/** One durable observation about the user, with a pointer to where it came from. */
export interface PersonaFact {
  kind: PersonaFactKind;
  text: string;
  evidence?: string;
  updatedAt: IsoDateTime;
}

export const personaFactSchema = z.object({
  kind: personaFactKindSchema,
  text: z.string().min(1),
  evidence: z.string().min(1).optional(),
  updatedAt: isoDateTimeSchema,
}).passthrough() satisfies z.ZodType<PersonaFact>;

/** A compact model of how one user works, keyed by subject. Stored as opaque
 *  data in a `vendo_records` row (id = subject). A bounded record, not a growing
 *  log, so it stays inside Vendo's Postgres-only, no-vector-search doctrine. */
export interface Persona {
  format: typeof PERSONA_FORMAT;
  subject: string;
  /** One short paragraph: how this user works. The field the agent reads first. */
  summary: string;
  facts: PersonaFact[];
  /** Provenance: how much history this was distilled from. */
  distilledFrom: { threads: number; auditEvents: number };
  updatedAt: IsoDateTime;
}

export const personaSchema = z.object({
  format: z.literal(PERSONA_FORMAT),
  subject: z.string().min(1),
  summary: z.string(),
  facts: z.array(personaFactSchema),
  distilledFrom: z.object({
    threads: z.number().int().nonnegative(),
    auditEvents: z.number().int().nonnegative(),
  }).passthrough(),
  updatedAt: isoDateTimeSchema,
}).passthrough() satisfies z.ZodType<Persona>;
