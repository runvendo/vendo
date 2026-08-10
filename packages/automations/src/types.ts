/**
 * The engine's internal shapes: the collections it owns, the schemas it reads
 * its own rows back through, and the row types those parse into.
 *
 * Lifted out of engine.ts unchanged. The PUBLIC surface (07 §1) stays in
 * index.ts — nothing here is exported from the package root.
 */
import {
  approvalRequestSchema,
  DEFAULT_TRIGGER_ID,
  type Json,
  type RunId,
  type Trigger,
} from "@vendoai/core";
import { z } from "zod";
import type { RunRecord } from "./index.js";

/** The stored app row, declared once in `@vendoai/apps/contract`. This engine
 *  reads the record's DATA half, which is what `AppData` is. */
import { appRowSchema, type AppData } from "@vendoai/apps/contract";
export { appRowSchema, type AppData };

export const APPS = "vendo_apps";
export const RUNS = "vendo_runs";
/** runs.list page size — the store's own default (100) is its escape hatch, not a UX. */
export const RUNS_PAGE_LIMIT = 50;
export const GRANTS = "vendo_grants";
export const APPROVALS = "vendo_approvals";
export const CAPTURES = "automations:captures";
export const SCHEDULE = "automations:schedule";
export const WEBHOOK = "automations:webhook";
export const DELIVERIES = "automations:deliveries";
/**
 * Which TRIGGERS of an app are armed — one row per armed (app, trigger).
 *
 * A second fact beside the app row's `enabled` boolean deliberately, and the two
 * mean different things: `enabled` is the APP-level arm the apps runtime already
 * owns (a trigger edit disarms the whole app there, §9.9), this is the
 * per-trigger arm a person turns on and off. A firing needs BOTH, so the
 * existing app-level disarm keeps working untouched and turning one trigger off
 * never reaches another.
 */
export const ARMED = "automations:armed";
export const WEBHOOK_MAX_BYTES = 1024 * 1024;
export const FOREACH_MAX_ITEMS = 1000;


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
  appId: z.string(),
  /** WHICH trigger this ask is for. A person consents per trigger, so a capture
   *  minted while arming one never settles another's ask for the same tool.
   *
   *  Defaulted rather than required, for the same reason the app document
   *  normalizes its pre-list `trigger` on read: a consent moment that was
   *  already open when triggers became a list has no id on its rows, and a
   *  strict parse would drop those asks out of the pending projection — the
   *  person would be left with an approval card and an automation that never
   *  hears the answer. */
  triggerId: z.string().default(DEFAULT_TRIGGER_ID),
  subject: z.string(),
  tool: z.string(),
  /** The service action this ask is for, when the tool is the connector
   *  dispatcher — the thing consented to, since its tool name is not its
   *  action. Absent for every host tool. */
  slug: z.string().optional(),
  descriptorHash: z.string(),
  /** The grant SET this pending ask belongs to (07 §3 grant capture; one
   *  enable() = one set). Optional: rows minted before sets existed have
   *  none and are adopted into the app's set on the next enable(). */
  grantSetId: z.string().optional(),
});

export type Capture = z.infer<typeof captureSchema>;

export const scheduleSchema = z.object({ lastFiredAt: z.string(), firedAt: z.string().optional() });
export const webhookSchema = z.object({ secret: z.string() });


/** One (app, trigger) a tick claimed the cursor for, and the schedule event it
 *  fires with. */
export interface FiredSchedule {
  row: AppData;
  trigger: Trigger;
  scheduledFor: string;
  firedAt: string;
}

export interface InternalRunRecord extends RunRecord {
  /** The event that fired this run, kept so `runs.rerun` can fire the SAME
   *  trigger on the SAME event. Internal: it is the host's own payload, and the
   *  public run record (07 §5) does not carry it. */
  __event?: Json;
  /** The FIRING this run belongs to: the id of its first run. A re-run inherits
   *  it, so a chain of re-runs shares ONE root rather than each pointing at its
   *  predecessor. Absent on a run that is nobody's re-run, which then IS its own
   *  root — persisted rather than derived, because the guard's effect ledger has
   *  to find the failed run's receipts in a different process. Internal, like
   *  `__event`: the public run record (07 §5) does not carry it. */
  __lineage?: RunId;
  /** The trigger definition this run actually fired, kept so `runs.rerun` fires
   *  THAT one rather than whatever the document says by then. A steps call id is
   *  positional (see `runSteps`), which is only stable across a re-run if the
   *  step list is — so an author inserting a step ahead of one that already
   *  completed would renumber it, its receipt would never be found, and work
   *  that had already landed would happen twice. Internal, like `__event`, and
   *  optional for the same reason: a row written before this existed falls back
   *  to the declared trigger, which is exactly the old behavior. */
  __trigger?: Trigger;
}

const runStatusSchema = z.enum(["running", "ok", "error", "stopped"]);

/** The same statuses, plus the one that used to exist. A run row written while
 *  parking existed can never resume now, and a strict parse would make ONE such
 *  row throw for every `runs.list` of its app — so it reads back as the loud
 *  failure it effectively is. Read-only: nothing writes this value any more. */
const storedRunStatusSchema = z.union([
  runStatusSchema,
  z.literal("pending-approval").transform((): z.infer<typeof runStatusSchema> => "error"),
]);

const baseRunRecordSchema = z.object({
  id: z.string(),
  appId: z.string(),
  /** Defaulted for the same reason `captureSchema.triggerId` above is: a run
   *  row written before triggers became a list names none, and it fired the
   *  app's only trigger, which is the default one. Strict, ONE such row threw
   *  for every `runs.list` of its app — a single legacy row took the whole
   *  history down, and the surface reading it got a 400 rather than a gap. */
  triggerId: z.string().default(DEFAULT_TRIGGER_ID),
  trigger: z.object({
    kind: z.enum(["schedule", "host-event", "external"]),
    event: z.string().optional(),
  }),
  status: storedRunStatusSchema,
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
  __trigger: z.unknown().optional(),
});

export const runRowDataSchema = z.object({
  appId: z.string(),
  trigger: baseRunRecordSchema.shape.trigger,
  status: storedRunStatusSchema,
  record: internalRunRecordSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
});

/** One thing a person is asked to allow for a trigger. A host tool is named by
 *  its tool; the connector dispatcher is named by the SERVICE ACTION it will
 *  call, because its tool name is not its action (01-core §5 `service-tool`). */
export interface ConsentItem {
  tool: string;
  slug?: string;
}
