/**
 * The engine's internal shapes: the collections it owns, the schemas it reads
 * its own rows back through, and the row types those parse into.
 *
 * The PUBLIC surface (07 §1) stays in index.ts — nothing here is exported from
 * the package root.
 */
import {
  approvalRequestSchema,
  automationRecordSchema,
  type AutomationRecord,
  type Json,
  type RunId,
} from "@vendoai/core";
import { z } from "zod";
import type { RunRecord } from "./index.js";

/** The reserved table an automation record lives in — one row per record,
 *  keyed by its id and ref'd by its owner's subject and its trigger kind. */
export const AUTOMATIONS = "vendo_automations";
export const RUNS = "vendo_runs";
/** runs.list page size — the store's own default (100) is its escape hatch, not a UX. */
export const RUNS_PAGE_LIMIT = 50;
export const GRANTS = "vendo_grants";
export const APPROVALS = "vendo_approvals";
export const CAPTURES = "automations:captures";
export const SCHEDULE = "automations:schedule";
export const DELIVERIES = "automations:deliveries";
export const WEBHOOK_MAX_BYTES = 1024 * 1024;
export const FOREACH_MAX_ITEMS = 1000;

export const automationRowSchema = automationRecordSchema;
export type { AutomationRecord };

/** The guard's approval row as this engine reads it. `passthrough`, because the
 *  guard owns this shape and keeps adding to it (`deniedBy`, `voidedAt`): a
 *  stripping parse would silently drop those on the write-back below, erasing
 *  who said no and whether it was taken back. */
export const approvalRowSchema = z.object({
  request: approvalRequestSchema,
  status: z.enum(["pending", "approved", "denied"]),
  sessionId: z.string().optional(),
  decidedAt: z.string().optional(),
  consumedAt: z.string().optional(),
  voidedAt: z.string().optional(),
}).passthrough();

export const captureSchema = z.object({
  /** WHICH automation this ask is for. A person consents per record, so a
   *  capture minted while arming one never settles another's ask for the same
   *  tool. */
  automationId: z.string(),
  subject: z.string(),
  tool: z.string(),
  /** The service action this ask is for, when the tool is the connector
   *  dispatcher — the thing consented to, since its tool name is not its
   *  action. Absent for every host tool. */
  slug: z.string().optional(),
  descriptorHash: z.string(),
  /** The grant SET this pending ask belongs to (07 §3 grant capture; one
   *  enable() = one set). */
  grantSetId: z.string().optional(),
});

export type Capture = z.infer<typeof captureSchema>;

export const scheduleSchema = z.object({ lastFiredAt: z.string(), firedAt: z.string().optional() });

/** One automation a tick claimed the cursor for, and the schedule event it fires
 *  with. */
export interface FiredSchedule {
  record: AutomationRecord;
  scheduledFor: string;
  firedAt: string;
}

export interface InternalRunRecord extends RunRecord {
  /** The event that fired this run, kept so `runs.rerun` can fire the SAME
   *  automation on the SAME event. Internal: it is the host's own payload, and
   *  the public run record (07 §5) does not carry it. */
  __event?: Json;
  /** The FIRING this run belongs to: the id of its first run. A re-run inherits
   *  it, so a chain of re-runs shares ONE root rather than each pointing at its
   *  predecessor. Absent on a run that is nobody's re-run, which then IS its own
   *  root — persisted rather than derived, because the guard's effect ledger has
   *  to find the failed run's receipts in a different process. */
  __lineage?: RunId;
  /** The record that actually fired, kept so `runs.rerun` fires THAT one rather
   *  than whatever is stored by then. A steps call id is positional (see
   *  `runSteps`), which is only stable across a re-run if the step list is — so
   *  an author inserting a step ahead of one that already completed would
   *  renumber it, its receipt would never be found, and work that had already
   *  landed would happen twice. */
  __record?: AutomationRecord;
}

const runStatusSchema = z.enum(["running", "ok", "error", "stopped"]);

const baseRunRecordSchema = z.object({
  id: z.string(),
  automationId: z.string(),
  owner: z.object({ kind: z.enum(["user", "org"]), subject: z.string() }).passthrough(),
  agent: z.string().optional(),
  trigger: z.object({
    kind: z.enum(["schedule", "host-event", "external"]),
    event: z.string().optional(),
  }),
  status: runStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  steps: z.array(z.object({
    id: z.string(),
    tool: z.string(),
    outcome: z.enum(["ok", "error", "pending-approval", "blocked", "connect-required"]),
    at: z.string(),
    detail: z.string().optional(),
  })),
  summary: z.string().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    tool: z.string().optional(),
    slug: z.string().optional(),
  }).optional(),
});

const internalRunRecordSchema = baseRunRecordSchema.extend({
  __event: z.unknown().optional(),
  __lineage: z.string().optional(),
  __record: z.unknown().optional(),
});

export const runRowDataSchema = z.object({
  automationId: z.string(),
  trigger: baseRunRecordSchema.shape.trigger,
  status: runStatusSchema,
  record: internalRunRecordSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
});

/** One thing a person is asked to allow for an automation. A host tool is named
 *  by its tool; the connector dispatcher is named by the SERVICE ACTION it will
 *  call, because its tool name is not its action (01-core §5 `service-tool`). */
export interface ConsentItem {
  tool: string;
  slug?: string;
}
