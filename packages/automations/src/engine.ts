import {
  auditContext,
  VendoError,
  approvalRequestSchema,
  appDocumentSchema,
  DEFAULT_TRIGGER_ID,
  descriptorHash,
  permissionGrantSchema,
  serviceToolPhrase,
  serviceToolSlug,
  TRIGGER_KIND_REF_PRESENT,
  triggerKindRefKey,
  triggerSchema,
  USE_SERVICE_TOOL,
  withResolvedRisk,
  webhookSubject,
  withheldFromUnattended,
  triggerKindRefs,
  type AppDocument,
  type ApprovalRequest,
  type AuditEvent,
  type Json,
  type PermissionGrant,
  type GrantScope,
  type RecordStore,
  type RunContext,
  type RunId,
  type Step,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type Trigger,
  type TriggerSource,
  type VendoRecord,
} from "@vendoai/core";
import { Cron } from "croner";
import jsonata from "jsonata";
import { z } from "zod";
import {
  currentIntentHash,
  declaredSurface,
  markSponsored,
  migratePreListSponsorship,
  readSponsorship,
  SPONSORED,
  SPONSORSHIPS,
  sponsorshipSchema,
  storedSponsorshipSchema,
  triggerKey,
  triggerOf,
  triggersOf,
  wasSponsored,
  writeSponsorship,
  type Sponsorship,
} from "./sponsorship.js";
import type {
  AutomationsConfig,
  AutomationsEngine,
  RunPlan,
  RunRecord,
  RunStatus,
} from "./index.js";

const APPS = "vendo_apps";
const RUNS = "vendo_runs";
/** runs.list page size — the store's own default (100) is its escape hatch, not a UX. */
const RUNS_PAGE_LIMIT = 50;
const GRANTS = "vendo_grants";
const APPROVALS = "vendo_approvals";
const CAPTURES = "automations:captures";
const SCHEDULE = "automations:schedule";
const WEBHOOK = "automations:webhook";
const DELIVERIES = "automations:deliveries";
/** The app row's trigger-kind ref BEFORE the trigger list: one key holding one
 *  kind. Kept only so the queries below can still find a row nobody has
 *  rewritten yet — nothing writes it any more. */
const PRE_LIST_TRIGGER_KIND_REF = "trigger_kind";
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
const ARMED = "automations:armed";
const WEBHOOK_MAX_BYTES = 1024 * 1024;
const FOREACH_MAX_ITEMS = 1000;

/** Every engine-owned generic row belongs to ONE app, and the 02-store §5 erase
 *  cascade collects generic rows by `refs @> {app_id}` — so a row written
 *  without this ref outlives the app forever. That is not only clutter: a
 *  webhook secret is a live signing key, and the delivery ledger has no other
 *  lifecycle at all. */
const appRef = (appId: string): Record<string, string> => ({ app_id: appId });

const appRowSchema = z.object({
  subject: z.string(),
  enabled: z.boolean(),
  doc: appDocumentSchema,
});

/** The guard's approval row as this engine reads it. `passthrough`, because the
 *  guard owns this shape and keeps adding to it (`deniedBy`, `voidedAt`): a
 *  stripping parse would silently drop those on the write-back below, erasing
 *  who said no and whether it was taken back. */
const approvalRowSchema = z.object({
  request: approvalRequestSchema,
  status: z.enum(["pending", "approved", "denied"]),
  sessionId: z.string().optional(),
  decidedAt: z.string().optional(),
  consumedAt: z.string().optional(),
  voidedAt: z.string().optional(),
}).passthrough();

const captureSchema = z.object({
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

type Capture = z.infer<typeof captureSchema>;

const scheduleSchema = z.object({ lastFiredAt: z.string(), firedAt: z.string().optional() });
const webhookSchema = z.object({ secret: z.string() });

interface AppRow {
  subject: string;
  enabled: boolean;
  doc: AppDocument;
}

/** One (app, trigger) a tick claimed the cursor for, and the schedule event it
 *  fires with. */
interface FiredSchedule {
  row: AppRow;
  trigger: Trigger;
  scheduledFor: string;
  firedAt: string;
}

interface InternalRunRecord extends RunRecord {
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
  triggerId: z.string(),
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

const runRowDataSchema = z.object({
  appId: z.string(),
  trigger: baseRunRecordSchema.shape.trigger,
  status: storedRunStatusSchema,
  record: internalRunRecordSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
});

/** Every stop sentence ends the same way, and must: the list and the stopped run
 *  row both print it, and they have to match byte for byte. */
const TAKE_IT_ON = " — anyone who can edit this app can turn it back on";

/** §9.9 — what a stopped automation says, in the consumer's voice. It names the
 *  automation and what anyone who can edit the app may do about it; the
 *  machinery (hashes, grants, principals) stays out of the sentence.
 *
 *  It never names the SPONSOR, and that is a durability rule rather than a
 *  style one: this sentence is PERSISTED on the run row, `vendo_runs` has no
 *  subject column (02-store §2), and the erase cascade reaches run rows only
 *  through the apps the subject OWNS — which for an org-owned automation is the
 *  org, and the org outlives the person (§9.7). A name written here would
 *  therefore survive its owner's own erasure. The name belongs on the audit row
 *  instead: it is derived from rows the cascade does reach. */
const SPONSORSHIP_STOP: Record<NonNullable<Sponsorship["reason"]>, (name: string) => string> = {
  edit: (name) => `stopped: ${name} changed after the person who set it up allowed it${TAKE_IT_ON}`,
  departure: (name) => `stopped: the person ${name} ran as no longer has access to it${TAKE_IT_ON}`,
  grants: (name) => `stopped: the permissions ${name} ran with were removed${TAKE_IT_ON}`,
};

/** The stopped shape three surfaces read: the reason, and the one sentence that
 *  goes with it. Built here so the list, the gate and the card cannot drift. */
const stopFor = (
  reason: NonNullable<Sponsorship["reason"]>,
  automationName: string,
): { reason: NonNullable<Sponsorship["reason"]>; summary: string } =>
  ({ reason, summary: SPONSORSHIP_STOP[reason](automationName) });

/** §9.9 — what a run says when the identity checks could not ANSWER (the
 *  host's memberships callback or access seam threw). The raw failure is a host
 *  system's error text — a DSN, a stack, a driver message — and the run row is
 *  rendered verbatim to consumers (`automations-panel.tsx` prints `summary` and
 *  `error.message`), so it says what happened and nothing about how. The raw
 *  detail goes to the audit row, which is where an operator looks. */
const IDENTITY_UNAVAILABLE = (name: string): string =>
  `stopped: ${name} could not check who it runs as — nothing ran, and it will try again on its next trigger`;

const clone = <T>(value: T): T => globalThis.structuredClone(value);
const id = (prefix: string): string => `${prefix}${globalThis.crypto.randomUUID()}`;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

const allRecords = async (
  records: ReturnType<AutomationsConfig["store"]["records"]>,
  query: { refs?: Record<string, string>; ids?: string[] } = {},
): Promise<VendoRecord[]> => {
  const found: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await records.list({ ...query, ...(cursor === undefined ? {} : { cursor }) });
    found.push(...page.records);
    if (page.cursor === undefined || page.cursor === cursor) break;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return found;
};

const parseAppRow = (record: VendoRecord): AppRow => {
  const result = appRowSchema.safeParse(record.data);
  if (!result.success) throw new VendoError("validation", `invalid app row ${record.id}: ${result.error.issues[0]?.message ?? "invalid"}`);
  return result.data;
};

/** The run the row carries. The wrapper columns beside it (`appId`, `status`,
 *  `startedAt`) are validated by the same parse and then never read: they are
 *  the store's own projection of the record, and the record is the run. */
const parseRunRecord = (record: VendoRecord): InternalRunRecord => {
  const result = runRowDataSchema.safeParse(record.data);
  if (!result.success) throw new VendoError("validation", `invalid run row ${record.id}: ${result.error.issues[0]?.message ?? "invalid"}`);
  return result.data.record as unknown as InternalRunRecord;
};

// Callers already validated the row via parseRunRecord; only the internal fields
// need stripping.
const publicRun = ({ __event: _, __lineage: __, __trigger: ___, ...record }: InternalRunRecord): RunRecord => record;

const triggerEvent = (source: TriggerSource): string | undefined =>
  source.kind === "host-event" || source.kind === "external" ? source.event : undefined;

const durationMs = (value: string): number | null => {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (match === null) return null;
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const units = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  return count * units[match[2] as keyof typeof units];
};

const validateTrigger = (value: unknown): Trigger => {
  const parsed = triggerSchema.safeParse(value);
  if (!parsed.success) throw new VendoError("validation", parsed.error.issues[0]?.message ?? "invalid trigger");
  const trigger = parsed.data;
  if (trigger.on.kind === "schedule") {
    if (trigger.on.every !== undefined && durationMs(trigger.on.every) === null) {
      throw new VendoError("validation", "schedule every must match <n><s|m|h|d> with n > 0");
    }
    if (trigger.on.cron !== undefined) {
      if (trigger.on.cron.trim().split(/\s+/).length !== 5) {
        throw new VendoError("validation", "schedule cron must contain exactly 5 fields");
      }
      try {
        new Cron(trigger.on.cron, { timezone: "UTC", paused: true });
      } catch (error) {
        throw new VendoError("validation", `invalid schedule cron: ${message(error)}`);
      }
    }
    if (trigger.on.at !== undefined && !Number.isFinite(Date.parse(trigger.on.at))) {
      throw new VendoError("validation", "schedule at must be an ISO date-time");
    }
  }
  return trigger;
};

const evaluate = async (expression: string, input: Record<string, Json>): Promise<Json> =>
  await jsonata(expression).evaluate(input) as Json;

const stepArgs = async (
  step: Step,
  event: Json,
  outputs: Record<string, Json>,
  item?: Json,
): Promise<Record<string, Json>> => {
  const context = { event, steps: outputs, item };
  const args: Record<string, Json> = {};
  for (const [key, expression] of Object.entries(step.args ?? {})) {
    args[key] = await evaluate(expression, context);
  }
  return args;
};

/** One thing a person is asked to allow for a trigger. A host tool is named by
 *  its tool; the connector dispatcher is named by the SERVICE ACTION it will
 *  call, because its tool name is not its action (01-core §5 `service-tool`). */
interface ConsentItem {
  tool: string;
  slug?: string;
}

/** The identity of a consent item — what "already asked for this" means, and
 *  therefore what two different service actions must NOT collapse into. */
const consentKey = (item: ConsentItem): string =>
  item.slug === undefined ? item.tool : `${item.tool}\u0000${item.slug}`;

/** Whether a standing automation grant already covers this consent item. A
 *  host tool wants the tool-wide grant it has always minted; a service action
 *  wants its own slug and is not covered by any other. */
const scopeCovers = (scope: GrantScope, slug?: string): boolean =>
  slug === undefined ? scope.kind === "tool" : scope.kind === "service-tool" && scope.slug === slug;

/** The service action a step declares, when it declares one.
 *
 *  Step args are JSONata, so the slug is only a declaration when it is a
 *  CONSTANT — an expression that needs the event resolves to nothing here. That
 *  is the right line rather than a limitation: an action nobody can name while
 *  the person is present is not one they can pre-approve, so that step parks at
 *  fire time and accretes its grant from a real approval instead. */
const declaredSlug = async (step: Step): Promise<string | undefined> => {
  if (step.tool !== USE_SERVICE_TOOL) return undefined;
  const expression = step.args?.["slug"];
  if (expression === undefined) return undefined;
  try {
    const value = await evaluate(expression, { event: null, steps: {} });
    return serviceToolSlug({ tool: step.tool, args: { slug: value } });
  } catch {
    return undefined;
  }
};

const outcomeDetail = (outcome: ToolOutcome): string | undefined => {
  if (outcome.status === "error") return outcome.error.message;
  if (outcome.status === "blocked") return outcome.reason;
  if (outcome.status === "pending-approval") return outcome.approvalId;
  if (outcome.status === "connect-required") return outcome.connect.message;
  return undefined;
};

const errorForOutcome = (outcome: Exclude<ToolOutcome, { status: "ok" }>): { code: string; message: string } => {
  if (outcome.status === "error") return outcome.error;
  if (outcome.status === "blocked") return { code: "blocked", message: outcome.reason };
  // An away run has no user to show a connect card to; the run fails with an
  // actionable message and the user connects in-product before re-running.
  if (outcome.status === "connect-required") return { code: "connect-required", message: outcome.connect.message };
  return { code: "blocked", message: `approval required: ${outcome.approvalId}` };
};

const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
};

const decodeBase64 = (value: string, url = false): Uint8Array | null => {
  try {
    let normalized = url ? value.replace(/-/g, "+").replace(/_/g, "/") : value;
    normalized += "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(normalized);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

const verifySignature = async (
  secret: string,
  signature: string,
  signed: Uint8Array,
): Promise<boolean> => {
  const keyBytes = decodeBase64(secret, true);
  const signatureBytes = decodeBase64(signature);
  if (keyBytes === null || signatureBytes === null) return false;
  try {
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await globalThis.crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      signed,
    );
  } catch {
    return false;
  }
};

const signedWebhookBytes = (deliveryId: string, timestamp: string, raw: Uint8Array): Uint8Array => {
  const prefix = new TextEncoder().encode(`${deliveryId}.${timestamp}.`);
  const signed = new Uint8Array(prefix.length + raw.length);
  signed.set(prefix);
  signed.set(raw, prefix.length);
  return signed;
};

const readLimitedBody = async (request: Request, limit: number): Promise<Uint8Array | null> => {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const terminalStatus = (status: RunStatus): status is Extract<RunStatus, "ok" | "error" | "stopped"> =>
  status === "ok" || status === "error" || status === "stopped";

const syncRun = (target: InternalRunRecord, source: InternalRunRecord): void => {
  delete target.finishedAt;
  delete target.summary;
  delete target.error;
  Object.assign(target, clone(source));
};

const validateForEachItems = (step: Step, value: Json): Json[] => {
  if (!Array.isArray(value)) throw new Error(`step ${step.id} forEach did not produce an array`);
  if (value.length > FOREACH_MAX_ITEMS) throw new Error(`step ${step.id} forEach exceeds ${FOREACH_MAX_ITEMS} items`);
  return value;
};

export const createAutomationsEngine = (config: AutomationsConfig): AutomationsEngine => {
  const now = (): Date => config.now?.() ?? new Date();
  const iso = (): string => now().toISOString();
  const stopped = new Set<string>();
  const active = new Set<string>();
  const inFlightDeliveries = new Set<string>();
  const abortControllers = new Map<string, AbortController>();
  let tickTail: Promise<void> = Promise.resolve();
  // Absent localTriggerKinds → every kind fires locally (today's behavior, unchanged).
  const firesLocally = (kind: "schedule" | "external"): boolean =>
    config.localTriggerKinds === undefined || config.localTriggerKinds.has(kind);

  const appRecord = async (appId: string): Promise<{ record: VendoRecord; row: AppRow } | null> => {
    const record = await config.store.records(APPS).get(appId);
    return record === null ? null : { record, row: parseAppRow(record) };
  };

  /** The app, for a caller allowed to CHANGE it — null when it is absent OR the
   *  caller cannot edit it, because those two answer alike everywhere. §8's
   *  editor = edit, and arming makes an editor the person an automation runs as,
   *  so arming, disarming and previewing are theirs too — not the owner's alone.
   *  With no access seam configured this is exactly the ownership check it
   *  replaces. */
  const editableAppOrNull = async (
    appId: string,
    ctx: RunContext,
  ): Promise<{ record: VendoRecord; row: AppRow } | null> => {
    const found = await appRecord(appId);
    return found === null || !await canEdit(ctx, found.row, appId) ? null : found;
  };

  /** The same door, for the callers that must refuse rather than answer empty.
   *  Existence-masking: someone who cannot edit hears "not found", not "no". */
  const editableApp = async (appId: string, ctx: RunContext): Promise<{ record: VendoRecord; row: AppRow }> => {
    const found = await editableAppOrNull(appId, ctx);
    if (found === null) throw new VendoError("not-found", `app not found: ${appId}`);
    return found;
  };

  /** The named trigger of an app, validated — the door every per-trigger
   *  ceremony (enable, dryRun) goes through. A trigger id the document
   *  does not declare is a caller's mistake, not an empty answer. */
  const declaredTrigger = (doc: AppDocument, triggerId: string): Trigger => {
    const declared = triggerOf(doc, triggerId);
    if (declared === undefined) throw new VendoError("validation", `app has no trigger "${triggerId}"`);
    return validateTrigger(declared);
  };

  const writeApp = async (record: VendoRecord, row: AppRow): Promise<void> => {
    // The per-kind trigger refs let the tick/emit fetch apps by trigger kind (the reserved store
    // derives them from columns and ignores caller refs; a generic StoreAdapter honors what we
    // pass here). ONE KEY PER KIND, because an app's triggers are a LIST: a single-valued ref
    // could only name one of them, and the others would never be queried at all.
    await config.store.records(APPS).put({
      id: record.id,
      data: row,
      refs: { subject: row.subject, ...triggerKindRefs(row.doc.triggers) },
    });
  };

  /**
   * Move any pre-rekey schedule cursor onto its (app, trigger) key, and return the
   * rows the tick should read for the keys that were missing.
   *
   * The cursor moved from the bare `appId` when an app became a LIST of triggers,
   * and no store rewrites GENERIC row ids, so the old row is invisible everywhere.
   * A cursor the tick cannot find reads as "start the clock now" (so a new
   * schedule does not backfill every window since the epoch) — applied to one that
   * merely moved, that silently restarts a running automation's clock.
   *
   * State is carried VERBATIM: it is the automation's own history, and rewriting
   * it would skip a window or replay one. Only `main` can have a bare-id cursor.
   * The old row is deleted once carried so it can never drag a newer cursor
   * backwards; an unparseable one is left alone and stays the missing cursor it
   * already was. Proven by schedule-cursor.test.ts.
   */
  const migratePreRekeyCursors = async (
    records: RecordStore,
    missing: readonly string[],
  ): Promise<VendoRecord[]> => {
    const preRekeyIds = missing
      .filter((key) => key.endsWith(`:${DEFAULT_TRIGGER_ID}`))
      .map((key) => key.slice(0, -`:${DEFAULT_TRIGGER_ID}`.length));
    if (preRekeyIds.length === 0) return [];
    const carried: VendoRecord[] = [];
    for (const record of await allRecords(records, { ids: preRekeyIds })) {
      const parsed = scheduleSchema.safeParse(record.data);
      if (!parsed.success) continue;
      carried.push(await records.put({
        id: triggerKey(record.id, DEFAULT_TRIGGER_ID),
        data: { ...parsed.data },
        refs: appRef(record.id),
      }));
      await records.delete(record.id);
    }
    return carried;
  };

  /**
   * The app rows that fire on this trigger kind, under EITHER ref spelling.
   *
   * One `trigger_kind: "<kind>"` ref became one key per kind when an app got a
   * LIST of triggers (a ref matches by equality; "which kinds" is a set). The
   * RESERVED store re-derives refs from generated columns, so it migrated itself;
   * a host-supplied adapter stores the refs it is GIVEN (01-core §12) and its
   * pre-list rows still carry the old key. Asking only the new key took every
   * automation armed before the rename dark on BYO storage — no error, no run
   * row, no audit event, the one failure mode an automation may never have.
   *
   * So both are asked and deduped by id. The old-key query ages out without a
   * sweep: `writeApp` re-derives refs, so the first arm, disarm or edit moves the
   * row across. Proven by byo-refs.test.ts.
   */
  const appsFiringOn = async (
    kind: TriggerSource["kind"],
    refs: Record<string, string> = {},
  ): Promise<VendoRecord[]> => {
    const records = config.store.records(APPS);
    // A store that VALIDATES its ref keys refuses the pre-list one — and that is
    // exactly the store which cannot be holding rows written under it, because it
    // DERIVES app refs from the document instead of storing what it was handed.
    // So a validation refusal here honestly means "no pre-list rows". Any other
    // failure still propagates: swallowing a dead connection would turn an outage
    // into "nothing is due", which is the silence this whole function exists to
    // end.
    const preListRows = async (): Promise<VendoRecord[]> => {
      try {
        return await allRecords(records, { refs: { ...refs, [PRE_LIST_TRIGGER_KIND_REF]: kind } });
      } catch (error) {
        if (error instanceof VendoError && error.code === "validation") return [];
        throw error;
      }
    };
    const [current, preList] = await Promise.all([
      allRecords(records, { refs: { ...refs, [triggerKindRefKey(kind)]: TRIGGER_KIND_REF_PRESENT } }),
      preListRows(),
    ]);
    const byId = new Map(current.map((record) => [record.id, record]));
    for (const record of preList) if (!byId.has(record.id)) byId.set(record.id, record);
    return [...byId.values()];
  };

  const setArmed = async (appId: string, triggerId: string, armed: boolean): Promise<void> => {
    const id = triggerKey(appId, triggerId);
    if (armed) await config.store.records(ARMED).put({ id, data: { appId, triggerId }, refs: { app_id: appId } });
    else await config.store.records(ARMED).delete(id);
  };

  /**
   * This app's armed triggers, given the armed keys already fetched. A trigger is
   * armed only when BOTH say so: the app-level `enabled` the apps runtime owns,
   * and the trigger's OWN armed row.
   *
   * There is deliberately no "enabled but no rows ⇒ all of them" fallback: it was
   * authority-widening, since a trigger added to the list later would fire
   * without anyone having armed it. The pre-list state it existed for is MIGRATED
   * in {@link armedFor} instead, which names the one trigger it always meant.
   */
  const armedTriggers = (row: AppRow, armed: ReadonlySet<string>): Trigger[] =>
    row.enabled
      ? triggersOf(row.doc).filter((trigger) => armed.has(triggerKey(row.doc.id, trigger.id)))
      : [];

  /**
   * The armed set for these app rows, migrating any pre-list row on the way.
   *
   * "Enabled with no per-trigger armed row at all" is the on-disk state of every
   * automation armed before triggers were a list, and it must not go quietly
   * dark. Resolved ONCE, here, by seeding the row it always meant: `main`, the id
   * a single-`trigger` document normalizes to. Deterministic (one id, never
   * "whatever the list holds now") and idempotent (the row it writes is what
   * makes the next read skip this).
   */
  const armedFor = async (rows: readonly AppRow[]): Promise<Set<string>> => {
    // ONE query for every (app, trigger) key, so per-trigger arming is not an
    // N+1 get on the tick's path.
    const keys = rows.flatMap(
      (row) => triggersOf(row.doc).map((trigger) => triggerKey(row.doc.id, trigger.id)),
    );
    const armed = new Set<string>(keys.length === 0
      ? []
      : (await allRecords(config.store.records(ARMED), { ids: keys })).map((record) => record.id));
    for (const row of rows) {
      if (!row.enabled) continue;
      const triggers = triggersOf(row.doc);
      if (triggers.some((trigger) => armed.has(triggerKey(row.doc.id, trigger.id)))) continue;
      if (!triggers.some((trigger) => trigger.id === DEFAULT_TRIGGER_ID)) continue;
      await setArmed(row.doc.id, DEFAULT_TRIGGER_ID, true);
      armed.add(triggerKey(row.doc.id, DEFAULT_TRIGGER_ID));
    }
    return armed;
  };

  /** The same question for one trigger, for the paths that hold a single app. */
  const isArmed = async (row: AppRow, triggerId: string): Promise<boolean> =>
    armedTriggers(row, await armedFor([row])).some((trigger) => trigger.id === triggerId);

  /** Turn ONE trigger off, leaving the app's others exactly as they were.
   *
   *  The remaining triggers are written out as explicit armed rows first. On a
   *  pre-list row that has none, the app-level flag was standing in for them —
   *  and the moment one trigger goes off, that flag can no longer say what is
   *  still armed. Materializing here is what keeps a disarm from taking a
   *  sibling with it. `enabled` then follows: false exactly when nothing is left. */
  const disarmTrigger = async (record: VendoRecord, row: AppRow, triggerId: string): Promise<void> => {
    const remaining = armedTriggers(row, await armedFor([row]))
      .filter((trigger) => trigger.id !== triggerId);
    for (const trigger of remaining) await setArmed(row.doc.id, trigger.id, true);
    await setArmed(row.doc.id, triggerId, false);
    row.enabled = remaining.length > 0;
    await writeApp(record, row);
  };

  // `ctx` rides through so the projection seam (design §12) is not silently
  // dropped here. Both callers — enable and dryRun — are PRESENT-time
  // ceremonies, so nothing is withheld: the owner must still see and grant
  // everything the automation declares, and dryRun must still explain it.
  const descriptors = async (ctx: RunContext): Promise<Map<string, ToolDescriptor>> =>
    new Map((await config.tools.descriptors(ctx)).map((descriptor) => [descriptor.name, descriptor]));

  /**
   * Every LIVE standing grant this (app, trigger) holds for the subject — the one
   * place the three fire-time questions below are asked from, so they cannot
   * answer differently about the same row.
   *
   * A grant minted while arming ONE trigger never authorizes another: the person
   * was shown that trigger's steps and consented to those. Rows minted before an
   * app had a trigger list carry no triggerId and stay valid for the trigger they
   * were minted for, which read-time normalization names `main`.
   */
  const liveAutomationGrants = async (
    subject: string,
    appId: string,
    triggerId: string,
    tool?: string,
  ): Promise<PermissionGrant[]> => {
    const records = await allRecords(config.store.records(GRANTS), {
      refs: { subject, app_id: appId, ...(tool === undefined ? {} : { tool }) },
    });
    const at = now().getTime();
    const grants: PermissionGrant[] = [];
    for (const record of records) {
      const parsed = permissionGrantSchema.safeParse(record.data);
      if (!parsed.success) continue;
      const grant = parsed.data;
      if (grant.subject !== subject || grant.appId !== appId) continue;
      if ((grant.triggerId ?? DEFAULT_TRIGGER_ID) !== triggerId) continue;
      if (grant.source !== "automation" || grant.duration !== "standing") continue;
      if (grant.revokedAt !== undefined) continue;
      if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= at) continue;
      grants.push(grant);
    }
    return grants;
  };

  const liveGrant = async (
    subject: string,
    appId: string,
    triggerId: string,
    descriptor: ToolDescriptor,
    slug?: string,
  ): Promise<boolean> =>
    (await liveAutomationGrants(subject, appId, triggerId, descriptor.name)).some((grant) =>
      grant.tool === descriptor.name
      && grant.descriptorHash === descriptorHash(descriptor)
      && scopeCovers(grant.scope, slug));

  /**
   * The service-action slugs THIS firing holds a live grant for.
   *
   * §12's projection withholds every `ungraded` tool from an unattended listing,
   * and the connector dispatcher is `ungraded` by construction — so without this
   * an agentic automation could never reach a connector at all, however
   * explicitly a person had allowed one action. The projection puts the
   * dispatcher back exactly when this is non-empty; the guard still decides each
   * call. Read at FIRE time rather than carried from arming, so a revoked grant
   * takes the door away on the next firing.
   */
  const grantedServiceSlugs = async (
    subject: string,
    appId: string,
    triggerId: string,
  ): Promise<string[]> => {
    const grants = await liveAutomationGrants(subject, appId, triggerId, USE_SERVICE_TOOL);
    const slugs = grants.flatMap((grant) => grant.scope.kind === "service-tool" ? [grant.scope.slug] : []);
    return [...new Set(slugs)].sort();
  };

  const audit = async (ctx: RunContext, status: string, extra: Record<string, Json> = {}): Promise<void> => {
    const event: AuditEvent = {
      id: id("aud_"),
      at: iso(),
      kind: "run",
      ...auditContext(ctx),
      // An automation run is away by definition, whatever the ctx says.
      venue: "automation",
      presence: "away",
      detail: { status, ...extra },
    };
    await config.guard.report(event);
  };

  const writeRun = async (record: InternalRunRecord): Promise<boolean> => {
    const stored = await config.store.records(RUNS).get(record.id);
    if (stored !== null) {
      const current = parseRunRecord(stored);
      if (terminalStatus(current.status)) {
        syncRun(record, current);
        return false;
      }
    }
    await config.store.records(RUNS).put({
      id: record.id,
      data: {
        appId: record.appId,
        trigger: record.trigger,
        status: record.status,
        record,
        startedAt: record.startedAt,
        ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
      },
      refs: { app_id: record.appId, status: record.status },
    });
    return true;
  };

  const sponsorships = (): RecordStore => config.store.records(SPONSORSHIPS);
  const sponsoredEra = (): RecordStore => config.store.records(SPONSORED);

  /** The sponsorship as the gates see it: the row, or — when the row is gone but
   *  the app was sponsored once — the fact that its sponsor was ERASED.
   *
   *  The ONE door every sponsorship read goes through, because it is also where
   *  the pre-list rekey is migrated: a row keyed by the bare app id is invisible
   *  under the pair key, and invisible reads as "never sponsored", which runs the
   *  automation as its OWNER. Taking the document rather than just its id is what
   *  lets the migration recompute the intent hash under the current formula. */
  const sponsorshipState = async (
    doc: AppDocument,
    triggerId: string,
  ): Promise<
    | { kind: "none" }
    | { kind: "erased" }
    | { kind: "row"; row: Sponsorship; revision?: string }
  > => {
    const appId = doc.id;
    const read = async (): Promise<
      { kind: "erased" } | { kind: "row"; row: Sponsorship; revision?: string } | undefined
    > => {
      const found = await readSponsorship(sponsorships(), appId, triggerId);
      if (found !== undefined) return { kind: "row", ...found };
      return await wasSponsored(sponsoredEra(), appId, triggerId) ? { kind: "erased" } : undefined;
    };
    const current = await read();
    if (current !== undefined) return current;
    const moved = await migratePreListSponsorship(
      sponsorships(),
      sponsoredEra(),
      appId,
      triggerId,
      currentIntentHash(doc, triggerOf(doc, triggerId)),
    );
    return (moved ? await read() : undefined) ?? { kind: "none" };
  };

  /** §9.3's `can(editor)`, through the config seam. With no seam configured the
   *  deployment has no app-access grants at all, so editor degenerates to
   *  ownership — exactly the wave-1 rule, and the reason this stays optional. */
  const canEdit = async (ctx: RunContext, row: AppRow, appId: string): Promise<boolean> =>
    config.appAccess === undefined
      ? row.subject === ctx.principal.subject
      : await config.appAccess.can(ctx, "editor", { app: appId });

  /** The run's context before any seam is consulted — a pure function of the run
   *  and a subject, so it cannot fail. It is what a failed identity resolution
   *  still audits under: a fire that cannot even resolve who it runs as must
   *  leave a record, not vanish. */
  const baseRunContext = (run: InternalRunRecord, subject: string): RunContext => ({
    principal: { kind: "user", subject },
    venue: "automation",
    presence: "away",
    sessionId: `sess_${run.id}`,
    appId: run.appId,
    // The firing trigger's own id rides here because the guard's away-grant
    // lookup matches on (app, trigger): without it a grant minted while arming
    // one trigger would authorize every sibling trigger's away calls, which is
    // the arm-time rule this run is supposed to be living under. `lineageId` is
    // the FIRING, not just the run: the guard's effect ledger keys receipts on
    // it, so a re-run can see what the run it re-runs already completed. A run
    // that is nobody's re-run is its own root.
    trigger: {
      runId: run.id,
      kind: run.trigger.kind,
      id: run.triggerId,
      lineageId: run.__lineage ?? run.id,
    },
  });

  /** §9.9 — the run's identity is its SPONSOR: an automation always runs as a
   *  named person. The app row's subject is the fallback for automations armed
   *  before sponsorship existed, and for a sponsorship that has lapsed (the
   *  fire-time gate below stops those runs anyway). */
  const runContext = async (doc: AppDocument, run: InternalRunRecord, subject: string): Promise<RunContext> => {
    // Through the migrating door, not `readSponsorship` — this read happens
    // BEFORE the fire-time gate below (the gate needs the sponsor's identity to
    // ask `can(editor)`), so a pre-list row still keyed by the app alone would
    // otherwise decide the run's identity while invisible.
    const state = await sponsorshipState(doc, run.triggerId);
    const ctx = baseRunContext(
      run,
      state.kind === "row" && state.row.status === "active" ? state.row.sponsor : subject,
    );
    const principal = ctx.principal;
    // §9.1 — memberships are ASSERTED per run, never stored: an unattended fire
    // has no session, so the engine resolves them from the host's own callback
    // and rides them on the ctx (the schema is passthrough, like `inClient` on
    // the open payload). `can()` reads them from there and never queries them.
    const memberships = await config.memberships?.(principal);
    if (memberships !== undefined) {
      (ctx as RunContext & { memberships?: readonly unknown[] }).memberships = memberships;
    }
    return ctx;
  };

  /** §9.9's fire-time gate, in ONE place: a run may proceed only while the
   *  sponsorship is active, the stored intent still matches the live document,
   *  and the sponsor can still edit the app. Any failure marks the sponsorship
   *  invalidated and the caller stops the run loudly before any tool call. */
  const sponsorshipRefusal = async (
    app: AppRow,
    trigger: Trigger,
    ctx: RunContext,
  ): Promise<{ reason: NonNullable<Sponsorship["reason"]>; summary: string } | undefined> => {
    const state = await sponsorshipState(app.doc, trigger.id);
    // Never sponsored: an automation armed before sponsorship shipped keeps
    // running as its owner rather than being stopped by a feature it predates.
    if (state.kind === "none") return undefined;
    // The sponsor's data was erased. Fail CLOSED — nothing is written here (a
    // write would re-create the row an erase just removed), and the card is
    // derived from this same state below.
    if (state.kind === "erased") return stopFor("departure", app.doc.name);
    const { row } = state;
    const refusal = (reason: NonNullable<Sponsorship["reason"]>) => stopFor(reason, app.doc.name);
    if (row.status !== "active") return refusal(row.reason ?? "edit");
    const invalidate = async (reason: NonNullable<Sponsorship["reason"]>) => {
      await writeSponsorship(sponsorships(), {
        ...row,
        status: "invalidated",
        reason,
        invalidatedAt: iso(),
      });
      return refusal(reason);
    };
    if (row.intentHash !== currentIntentHash(app.doc, trigger)) return await invalidate("edit");
    // §9.9's vocabulary distinguishes the two ways a sponsor stops being able to
    // run it: "departure" is the person being GONE (the erased-sponsor branch
    // above), "grants" is the person still being there and having lost access —
    // which is exactly what a failed `can(editor)` means. They produce different
    // consumer sentences, so the label is not cosmetic.
    if (!await canEdit(ctx, app, app.doc.id)) return await invalidate("grants");
    return undefined;
  };

  const terminal = async (
    run: InternalRunRecord,
    ctx: RunContext,
    status: Extract<RunStatus, "ok" | "error" | "stopped">,
    summary: string,
    error?: NonNullable<RunRecord["error"]>,
  ): Promise<void> => {
    run.status = status;
    run.finishedAt = iso();
    run.summary = summary;
    if (error === undefined) delete run.error;
    else run.error = error;
    if (await writeRun(run)) await audit(ctx, status);
  };

  /** A capture row, keyed by the approval it is the ask for. Captures are a
   *  GENERIC collection and the 02-store §5 erase cascade finds generic rows by
   *  their refs, so the refs are derived HERE rather than at each writer: an
   *  unref'd capture outlives both the person who was asked and the app that
   *  asked. (Approvals need none: `vendo_approvals` is reserved, derives its own
   *  refs, and is erased by its subject column.) */
  const writeCapture = async (approvalId: string, capture: Capture): Promise<void> => {
    await config.store.records(CAPTURES).put({
      id: approvalId,
      data: { ...capture },
      refs: { subject: capture.subject, app_id: capture.appId, trigger_id: capture.triggerId },
    });
  };

  /** Is this approval still an open question? A capture whose approval is gone
   *  or already decided is stale, and stale asks are not what a person is
   *  waiting on. */
  const isPendingAsk = async (approvalId: string): Promise<boolean> => {
    const approval = await config.store.records(APPROVALS).get(approvalId);
    if (approval === null) return false;
    const parsed = approvalRowSchema.safeParse(approval.data);
    return parsed.success && parsed.data.status === "pending" && parsed.data.voidedAt === undefined;
  };

  /**
   * A step met a permission nobody has granted. The run ends HERE, loudly.
   *
   * Two things happen, and the order matters: the ask the guard just raised is
   * written as a CAPTURE first — the same row arming writes, so `handleDecision`
   * mints the standing grant through the one path both doors already share, and
   * the surfaces that project "waiting on N permissions" count this ask too —
   * and only then does the run land on its terminal error row. A crash between
   * the two leaves a capture whose approval is still pending, which the next
   * enable() adopts into its set; a crash the other way round would leave a run
   * telling someone to grant something no surface can find.
   *
   * ONE capture per thing-to-allow, though, and exactly one ASK: when the person
   * is already being asked exactly this — an arming ask for the same tool (and
   * service action) that nobody has answered yet — only one of the pair may stay
   * open. Two rows for one question count one permission as two on every surface
   * that projects the outstanding asks, and settle as two grants for authority
   * the person allowed once.
   *
   * WHICH one survives is not a toss-up. The run's ask is raised inside the
   * firing and carries `presence: "away"`, the `appId` and its run id; the
   * arming ask is a present-time row with none of that. Away provenance is what
   * every away-authority rule is enforced against, so the run's ask is the
   * survivor and the arming ask is superseded — its capture moved onto the
   * survivor (same grant set, so the question stays one question) and the ask
   * itself closed with the same feature-detected `abandonApprovals` the chat
   * door uses for an ask nobody needs answered. Order matters again here: the
   * capture moves BEFORE the ask is closed, so the decision subscriber finds no
   * capture and cannot mistake a supersede for a person's denial — which would
   * disarm an automation nobody said no to.
   *
   * The two sentences part ways on purpose (§16 law 3): `summary` is rendered
   * verbatim to whoever owns the automation, so it says what happened and what
   * to do; `error.message` names the TOOL, which is a developer's word, and
   * rides the dev-mode rail — with `tool`/`slug` beside it so a surface can
   * offer Grant & re-run without parsing a sentence.
   */
  const needsPermission = async (
    run: InternalRunRecord,
    ctx: RunContext,
    step: Step,
    approvalId: string,
  ): Promise<void> => {
    const approval = await config.store.records(APPROVALS).get(approvalId);
    const parsed = approval === null ? undefined : approvalRowSchema.safeParse(approval.data);
    const request = parsed?.success === true ? parsed.data.request : undefined;
    const slug = request === undefined ? undefined : serviceToolSlug(request.call);
    if (request !== undefined) {
      const forTrigger = (await pendingCaptures(ctx.principal.subject))
        .filter((capture) => capture.data.appId === run.appId && capture.data.triggerId === run.triggerId);
      const asked = forTrigger.find((capture) =>
        consentKey(capture.data) === consentKey({ tool: request.call.tool, ...(slug === undefined ? {} : { slug }) }));
      const live = asked === undefined ? false : await isPendingAsk(asked.id);
      // The run's own ask is ALWAYS the captured one — whether the arming ask it
      // replaces was already decided (stale capture) or is still open (a live
      // one being superseded). One grant set per (app, trigger), shared with
      // arming: a person deciding this ask settles everything else outstanding
      // for the same trigger.
      await writeCapture(approvalId, {
        appId: run.appId,
        triggerId: run.triggerId,
        subject: ctx.principal.subject,
        tool: request.call.tool,
        ...(slug === undefined ? {} : { slug }),
        descriptorHash: descriptorHash(request.descriptor),
        grantSetId: forTrigger[0]?.data.grantSetId ?? id("gset_"),
      });
      if (asked !== undefined && asked.id !== approvalId) {
        // The capture moves off the ask being replaced BEFORE that ask is
        // touched: a capture on a decided approval keeps a settled question open
        // on the panel, and — when the ask below is closed — a capture still
        // sitting here would make the decision subscriber read a supersede as a
        // person's denial and disarm an automation nobody said no to.
        await config.store.records(CAPTURES).delete(asked.id);
        // A STILL-OPEN arming ask for this same thing is now redundant: the
        // question is one question, and the run's ask is the one that carries
        // where it was met (`presence: "away"`, the appId, the run id). Left
        // pending it kept "waiting on 1 permission" and a live Allow/Deny card
        // for a permission already granted, kept the needs-you badge lit, and
        // survived a reload — nothing closed it but the hour-long TTL sweep.
        //
        // `abandonApprovals` is the existing verb for an ask nobody needs
        // answered. It denies as `system`, which is explicitly NOT a standing no
        // (the guard only enforces `deniedBy: "human"`), mints nothing, and is
        // idempotent. Optional on the seam, so feature-detected the same way the
        // chat door does it — a guard without it keeps the pre-existing
        // behaviour, with the TTL sweep as the backstop.
        if (live) await config.guard.abandonApprovals?.([asked.id], ctx);
      }
    }
    const named = slug === undefined ? `use ${step.tool}` : serviceToolPhrase(slug);
    await terminal(
      run,
      ctx,
      "error",
      `stopped at ${step.id}: it needs a permission nobody has allowed yet`
      + " — allow it and run this again",
      {
        code: "needs-permission",
        message: `needs permission to ${named}`,
        tool: step.tool,
        ...(slug === undefined ? {} : { slug }),
      },
    );
  };

  const appendOutcome = (run: InternalRunRecord, step: Step, outcome: ToolOutcome): void => {
    const detail = outcomeDetail(outcome);
    run.steps.push({
      id: step.id,
      tool: step.tool,
      outcome: outcome.status,
      at: iso(),
      ...(detail === undefined ? {} : { detail }),
    });
  };

  const executeCall = async (
    appId: string,
    step: Step,
    call: ToolCall,
    ctx: RunContext,
  ): Promise<ToolOutcome> => step.tool.startsWith("fn:")
    ? await config.apps.call(appId, step.tool, call.args, ctx)
    : await config.tools.execute(call, ctx);

  const finishStoppedIfNeeded = async (run: InternalRunRecord): Promise<boolean> => {
    if (stopped.has(run.id)) {
      // runs.stop persisted and audited the authoritative stopped row; this is a stale in-flight copy.
      run.status = "stopped";
      return true;
    }
    const stored = await config.store.records(RUNS).get(run.id);
    if (stored !== null) {
      const current = parseRunRecord(stored);
      if (terminalStatus(current.status)) {
        syncRun(run, current);
        return true;
      }
    }
    if (terminalStatus(run.status)) return true;
    return false;
  };

  const failStep = async (
    run: InternalRunRecord,
    ctx: RunContext,
    step: Step,
    error: unknown,
  ): Promise<void> => {
    const failed: ToolOutcome = { status: "error", error: { code: "validation", message: message(error) } };
    appendOutcome(run, step, failed);
    await terminal(run, ctx, "error", `stopped at ${step.id}: ${message(error)}`, failed.error);
  };

  /** A steps run, always from the top. There is no mid-run resume: a run that
   *  meets a permission it does not hold fails LOUDLY and `runs.rerun` starts a
   *  FRESH run of the same firing (07 §5), so the only state carried between
   *  steps is the outputs they have produced. */
  const continueSteps = async (
    app: AppRow,
    trigger: Trigger,
    run: InternalRunRecord,
    ctx: RunContext,
    event: Json,
  ): Promise<void> => {
    if (trigger.run.kind !== "steps") throw new VendoError("validation", "steps run expected");
    const steps = trigger.run.steps;
    const stepOutputs: Record<string, Json> = {};
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      if (await finishStoppedIfNeeded(run)) return;
      const step = steps[stepIndex] as Step;
      let items: Json[] | undefined;
      const outputs: Json[] = [];
      try {
        if (step.if !== undefined && !await evaluate(step.if, { event, steps: stepOutputs, item: undefined })) {
          continue;
        }
        if (step.forEach !== undefined) {
          const evaluated = await evaluate(step.forEach, { event, steps: stepOutputs, item: undefined });
          items = validateForEachItems(step, evaluated);
        }
      } catch (error) {
        await failStep(run, ctx, step, error);
        return;
      }

      const iterations: Array<{ item?: Json; index?: number }> = items === undefined
        ? [{}]
        : items.map((item, index) => ({ item, index }));
      for (const iteration of iterations) {
        if (await finishStoppedIfNeeded(run)) return;
        let args: Record<string, Json>;
        try {
          args = await stepArgs(step, event, stepOutputs, iteration.item);
        } catch (error) {
          await failStep(run, ctx, step, error);
          return;
        }
        // Derived, not random: the guard's effect ledger tells "this call again"
        // apart from "another call just like it" by CALL ID, so the same step of
        // the same firing has to present the same id every time it runs. A random
        // id made a re-run look like a second, separately-intended call, and the
        // receipt for work that had already landed was never consulted.
        //
        // Positional, not by step id: nothing validates that step ids are unique
        // within a list, and two steps sharing one would then share a call id —
        // turning a document's own sloppiness into a SKIPPED mutation. The index
        // is unique by construction and just as stable across a re-run, since the
        // re-run reads the same step list. The id rides along so the value is
        // still readable in a log, and the iteration index is in it because one
        // forEach step is many calls that are genuinely different ones.
        const call: ToolCall = {
          id: `call_${run.__lineage ?? run.id}_${stepIndex}_${step.id}`
            + (iteration.index === undefined ? "" : `_${iteration.index}`),
          tool: step.tool,
          args,
        };
        const outcome = await executeCall(app.doc.id, step, call, ctx);
        if (await finishStoppedIfNeeded(run)) return;
        appendOutcome(run, step, outcome);
        if (outcome.status === "pending-approval") {
          await needsPermission(run, ctx, step, outcome.approvalId);
          return;
        }
        if (outcome.status !== "ok") {
          const error = errorForOutcome(outcome);
          await terminal(run, ctx, "error", `stopped at ${step.id}: ${error.message}`, error);
          return;
        }
        if (items === undefined) stepOutputs[step.id] = outcome.output;
        else outputs.push(outcome.output);
      }
      if (items !== undefined) stepOutputs[step.id] = outputs;
    }
    const okCount = run.steps.filter((entry) => entry.outcome === "ok").length;
    await terminal(run, ctx, "ok", `${okCount} ${okCount === 1 ? "step" : "steps"} ok`);
  };

  const runAgentic = async (
    trigger: Trigger,
    run: InternalRunRecord,
    ctx: RunContext,
    abortSignal: AbortSignal,
  ): Promise<void> => {
    if (trigger.run.kind !== "agentic") throw new VendoError("validation", "agentic run expected");
    if (config.runner === undefined) {
      await terminal(
        run,
        ctx,
        "error",
        "agentic runs unavailable",
        { code: "not-implemented", message: "agentic runs unavailable" },
      );
      return;
    }
    try {
      // At 2am the run sees the dispatcher, but caged: only the slugs this
      // (app, trigger) was actually granted are worth offering it for, so the
      // firing's own grants ride the ctx and §12's projection reads them. Every
      // other withheld tool stays withheld, and which slug may RUN is still the
      // guard's decision at call time.
      const listingCtx: RunContext = {
        ...ctx,
        grantedServiceSlugs: await grantedServiceSlugs(
          ctx.principal.subject,
          run.appId,
          run.triggerId,
        ),
      };
      const report = await config.runner({
        prompt: trigger.run.prompt,
        // The whole registry, and §12's projection is what narrows it: an away ctx
        // withholds every destructive AND every `ungraded` descriptor. The one
        // exemption is the connector dispatcher, and only for a firing that holds
        // a live per-slug service grant (`grantedServiceSlugs` above).
        tools: config.tools,
        budget: { maxToolCalls: trigger.run.budget?.maxToolCalls ?? 50 },
        abortSignal,
      }, listingCtx);
      // Cross-instance stops cannot reach this process's controller, so the persisted
      // terminal-row check remains the best-effort fallback for a late result.
      if (await finishStoppedIfNeeded(run)) return;
      run.steps = report.toolCalls.map(({ call, outcome }) => ({
        id: call.id,
        tool: call.tool,
        outcome,
        at: iso(),
      }));
      await terminal(run, ctx, report.status, report.summary);
    } catch (error) {
      if (await finishStoppedIfNeeded(run)) return;
      await terminal(run, ctx, "error", message(error), { code: "not-implemented", message: message(error) });
    }
  };

  // Mint the run and its record synchronously (so the id is known immediately), then
  // execute the whole automation on the returned `done` promise. Splitting the id from the
  // completion lets the tick collect runIds without blocking on each run to finish, and lets
  // it bound how long it waits on any single run (see runFiredSchedules).
  const launchRun = (
    app: AppRow,
    declared: Trigger,
    kind: TriggerSource["kind"],
    event: Json,
    /** The firing this run continues, when it is a re-run of one. */
    lineage?: RunId,
  ): { runId: RunId; done: Promise<void> } => {
    const trigger = validateTrigger(declared);
    const runId = id("run_");
    const eventName = triggerEvent(trigger.on);
    const record: InternalRunRecord = {
      id: runId,
      appId: app.doc.id,
      triggerId: trigger.id,
      trigger: { kind, ...(eventName === undefined ? {} : { event: eventName }) },
      status: "running",
      startedAt: iso(),
      steps: [],
      // What fired it, so `runs.rerun` can fire the same trigger on the same
      // event without the caller having to keep the payload.
      __event: clone(event),
      // The definition that fired, so a re-run cannot be renumbered by an edit
      // that landed after the failure.
      __trigger: clone(trigger),
      ...(lineage === undefined ? {} : { __lineage: lineage }),
    };
    const agentController = trigger.run.kind === "agentic" ? new AbortController() : undefined;
    if (agentController !== undefined) abortControllers.set(runId, agentController);
    const done = (async (): Promise<void> => {
      // Build contract §9.1 — asserting the owner's orgs is an I/O call (the
      // host's own query), so it happens INSIDE the run, not while minting its
      // id: `launchRun` stays synchronous so the tick can collect run ids
      // without blocking on any single automation. It is also fallible, which
      // is why the resolution sits inside the guarded block below and never
      // above it — a throw out here has no run row to attach itself to.
      try {
        // §9.9's gate runs BEFORE any step or agentic dispatch, and its two
        // outcomes both end the run LOUDLY — a persisted error row plus its own
        // audit event — because an automation that quietly stops firing is
        // indistinguishable from one nobody needs:
        //  - a lapsed sponsorship (the gate said no), and
        //  - a gate that could not ANSWER, because the host's memberships
        //    callback or access seam threw. That throw used to escape here, and
        //    the schedule path swallows a rejected run, so the whole firing
        //    vanished: no row, no audit, nothing to look at.
        let ctx = baseRunContext(record, app.subject);
        let stop:
          | { reason?: NonNullable<Sponsorship["reason"]>; summary: string; detail?: string }
          | undefined;
        try {
          ctx = await runContext(app.doc, record, app.subject);
          stop = await sponsorshipRefusal(app, trigger, ctx);
        } catch (error) {
          // The consumer sentence and the operator's detail part ways here:
          // `summary` is rendered verbatim in the automations panel, so
          // the host's raw throw rides the audit row below instead.
          stop = { summary: IDENTITY_UNAVAILABLE(app.doc.name), detail: message(error) };
        }
        if (stop !== undefined) {
          await writeRun(record);
          await audit(
            ctx,
            stop.reason === undefined ? "sponsorship-check-failed" : "sponsorship-invalidated",
            {
              ...(stop.reason === undefined ? {} : { reason: stop.reason }),
              summary: stop.summary,
              ...(stop.detail === undefined ? {} : { detail: stop.detail }),
            },
          );
          await terminal(record, ctx, "error", stop.summary, {
            code: stop.reason === undefined ? "error" : "blocked",
            message: stop.summary,
          });
          return;
        }
        await writeRun(record);
        await audit(ctx, "running");
        active.add(runId);
        try {
          if (trigger.run.kind === "steps") {
            await continueSteps(app, trigger, record, ctx, event);
          } else {
            await runAgentic(trigger, record, ctx, agentController!.signal);
          }
        } finally {
          active.delete(runId);
          stopped.delete(runId);
        }
      } finally {
        if (agentController !== undefined) abortControllers.delete(runId);
      }
    })();
    return { runId, done };
  };

  const startRun = async (
    app: AppRow,
    trigger: Trigger,
    kind: TriggerSource["kind"],
    event: Json,
  ): Promise<RunId> => {
    const { runId, done } = launchRun(app, trigger, kind, event);
    await done;
    return runId;
  };

  const delay = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never keep the event loop alive just for the tick's timeout.
    (timer as unknown as { unref?: () => void }).unref?.();
  });

  // Execute fired automations with bounded parallelism and an optional per-run timeout, so
  // one hung/slow run cannot block other tenants or overrun the tick interval. All runIds are
  // returned regardless of whether their run finished within the timeout (a timed-out run keeps
  // running detached and persists its own terminal state).
  const runFiredSchedules = async (fired: readonly FiredSchedule[]): Promise<RunId[]> => {
    const concurrency = Math.max(1, Math.floor(config.tickConcurrency ?? 4));
    const timeoutMs = config.runTimeoutMs;
    const ids: Array<RunId | undefined> = new Array(fired.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= fired.length) return;
        const entry = fired[index] as FiredSchedule;
        let launched: { runId: RunId; done: Promise<void> };
        try {
          launched = launchRun(entry.row, entry.trigger, "schedule", {
            scheduledFor: entry.scheduledFor,
            firedAt: entry.firedAt,
          });
        } catch {
          // A run that cannot even start (e.g. an invalid trigger) is skipped so other
          // tenants' fired runs still proceed.
          continue;
        }
        ids[index] = launched.runId;
        // A detached (timed-out) run must never surface as an unhandled rejection.
        const settled = launched.done.catch(() => undefined);
        if (timeoutMs === undefined) await settled;
        else await Promise.race([settled, delay(timeoutMs)]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, fired.length) }, () => worker()),
    );
    return ids.filter((value): value is RunId => value !== undefined);
  };

  const mintGrant = async (request: ApprovalRequest, triggerId: string | undefined): Promise<string> => {
    // A connector dispatch is granted at the width of its SLUG, never its tool
    // name: "allow use_service_tool" would be consent to the broker's whole
    // catalog. Every other tool keeps the tool-wide grant an automation has
    // always minted — the slug is the only thing that narrows here.
    const slug = serviceToolSlug(request.call);
    const grant: PermissionGrant = {
      id: id("grt_"),
      subject: request.ctx.principal.subject,
      tool: request.call.tool,
      descriptorHash: descriptorHash(request.descriptor),
      scope: slug === undefined ? { kind: "tool" } : { kind: "service-tool", slug },
      duration: "standing",
      ...(request.ctx.appId === undefined ? {} : { appId: request.ctx.appId }),
      // The trigger the person was actually looking at. Without it the grant
      // would be app-wide, and arming one trigger would silently authorize every
      // other trigger of the same app.
      ...(triggerId === undefined ? {} : { triggerId }),
      source: "automation",
      grantedAt: iso(),
    };
    await config.store.records(GRANTS).put({
      id: grant.id,
      data: grant,
      refs: {
        subject: grant.subject,
        tool: grant.tool,
        ...(grant.appId === undefined ? {} : { app_id: grant.appId }),
        // The reserved grants table derives this ref from the row's own column,
        // but a generic StoreAdapter honors what is passed here — and one that
        // filtered on `app_id` alone would hand back a sibling trigger's grant,
        // making the ref-trusting adapter WIDER than the JS filter above it.
        ...(grant.triggerId === undefined ? {} : { trigger_id: grant.triggerId }),
      },
    });
    return grant.id;
  };

  /**
   * Spends the approval this consent moment rode in on — through the guard when
   * it offers the seam, so the spend contends with a concurrent
   * `approvals.revoke` on the one transition instead of racing beside it. False
   * means DO NOT grant: the person took the yes back, or someone else already
   * spent it.
   *
   * KNOWN LIMIT — the fallback cannot linearize. A custom Guard that does not
   * offer `spendApproval` exposes no way to claim the approval's one-time
   * transition, so this path is back to reading the row and writing it: it
   * refuses a take-back it can see and writes the row back whole (no stripped
   * `deniedBy`/`voidedAt`), but a revoke landing inside that window can still
   * lose to the grant mint. Every Guard in this repo — the only one hosts get
   * unless they write their own — has the seam, and a host that replaces the
   * guard wholesale already owns its own consent bookkeeping. Not chased.
   */
  const spendApproval = async (record: VendoRecord): Promise<boolean> => {
    const data = approvalRowSchema.parse(record.data);
    if (config.guard.spendApproval !== undefined) {
      return await config.guard.spendApproval(record.id, data.request.ctx.principal) === "spent";
    }
    if (data.voidedAt !== undefined) return false;
    await config.store.records(APPROVALS).put({
      id: record.id,
      data: { ...data, consumedAt: iso() },
    });
    return true;
  };

  /** Whether the TRIGGER holds ANY live automation-source standing grant — the
   *  evidence a consent moment granted it something. Per trigger, because the
   *  deny path below disarms exactly the trigger the person said no to, and a
   *  sibling trigger's grants are not evidence about this one. */
  const anyLiveAutomationGrant = async (
    subject: string,
    appId: string,
    triggerId: string,
  ): Promise<boolean> =>
    (await liveAutomationGrants(subject, appId, triggerId)).some((grant) => grant.scope.kind !== "exact");

  const handleDecision = async (approvalId: string, approved: boolean): Promise<void> => {
    const capture = await config.store.records(CAPTURES).get(approvalId);
    if (capture !== null) {
      const parsed = captureSchema.parse(capture.data);
      const approval = await config.store.records(APPROVALS).get(approvalId);
      if (approved && approval !== null) {
        const data = approvalRowSchema.parse(approval.data);
        // Spend before granting: a yes the person took back at this instant
        // must arm nothing, and only one of the two can win the transition.
        if (await spendApproval(approval)) await mintGrant(data.request, parsed.triggerId);
      }
      await config.store.records(CAPTURES).delete(approvalId);
      if (!approved) {
        // Deny is transactional at the DECISION (criterion 19, deny half),
        // but disarms ONLY a consent moment that ended with NOTHING granted:
        // no capture asks left pending for the trigger and no live
        // automation-source grant held. A partially granted automation stays
        // armed — its ungranted steps FAIL LOUD at fire time (05 §6, J5) and
        // ask again there. Scoped to the TRIGGER: saying no to one
        // trigger's ask must never disarm a sibling that is running fine.
        const outstanding = (await pendingCaptures(parsed.subject)).some((candidate) =>
          candidate.data.appId === parsed.appId && candidate.data.triggerId === parsed.triggerId);
        if (!outstanding && !(await anyLiveAutomationGrant(parsed.subject, parsed.appId, parsed.triggerId))) {
          const found = await appRecord(parsed.appId);
          if (found !== null && found.row.subject === parsed.subject && found.row.enabled) {
            await disarmTrigger(found.record, found.row, parsed.triggerId);
          }
        }
      }
      return;
    }
    const approval = await config.store.records(APPROVALS).get(approvalId);
    if (approval === null || !approved) return;
    const data = approvalRowSchema.parse(approval.data);
    if (
      data.status === "approved"
      && data.consumedAt === undefined
      && data.request.ctx.venue === "automation"
      && data.request.ctx.appId !== undefined
    ) {
      // An away approval nothing captured — an AGENTIC run's own ask (a steps
      // run writes a capture at the miss, so it never reaches here). Approval
      // arms the app-bound authority for the next firing; it does not resume
      // anything, which is now the law everywhere rather than an agentic
      // exception: the failed run stays failed, and the remedy is `runs.rerun`.
      //
      // The trigger comes from the RUN this approval was raised inside: an away
      // approval carries its run id on the context (`trigger.runId`), and the
      // run row is the only thing that knows which of the app's triggers fired.
      // Without it the grant would be app-wide and the next firing of a DIFFERENT
      // trigger would inherit authority nobody consented to for it.
      const runId = data.request.ctx.trigger?.runId;
      const runRow = runId === undefined ? null : await config.store.records(RUNS).get(runId);
      const triggerId = runRow === null ? undefined : parseRunRecord(runRow).triggerId;
      if (await spendApproval(approval)) await mintGrant(data.request, triggerId);
    }
  };

  // Returned as a thenable so a guard that awaits subscribers (ours does)
  // makes decide() deterministic through resumption; guards that don't still
  // get fire-and-forget behavior.
  config.guard.onApprovalDecision((approvalId, approved) =>
    handleDecision(approvalId, approved) as unknown as void);

  /** Every still-pending capture for the subject, parsed — the outstanding
   *  grant sets. Captures are engine-owned and deleted on decision, so
   *  "capture exists" ≈ "ask is pending"; volume stays tiny (undecided asks
   *  only), so an unindexed scan is fine on every adapter. */
  const pendingCaptures = async (subject: string): Promise<Array<{ id: string; data: Capture }>> => {
    const records = await allRecords(config.store.records(CAPTURES));
    const captures: Array<{ id: string; data: Capture }> = [];
    for (const record of records) {
      const parsed = captureSchema.safeParse(record.data);
      if (parsed.success && parsed.data.subject === subject) captures.push({ id: record.id, data: parsed.data });
    }
    return captures;
  };

  /** The tools a consent moment has to ask THIS subject about: the automation's
   *  surface minus whatever they already hold a live standing grant for.
   *
   *  One caller (07 §3): enable(), where the person arming the automation
   *  approves its reads and writes AS THEMSELVES. */
  const captureGrants = async (
    doc: AppDocument,
    trigger: Trigger,
    byName: Map<string, ToolDescriptor>,
    ctx: RunContext,
  ): Promise<{ missing: ApprovalRequest[]; grantSetId: string }> => {
    const appId = doc.id;
    const triggerId = trigger.id;
    const subject = ctx.principal.subject;
    const surface = await consentSurface(trigger, byName);
    // One grant SET per TRIGGER: re-enables reuse that trigger's still-pending
    // asks (and their set id) instead of minting duplicates for the same
    // (appId, triggerId, tool); a fresh set id is minted only when nothing is
    // pending. Scoped to the trigger, because a sibling trigger's pending ask
    // for the same tool is a different question about different steps.
    const pendingForApp = new Map(
      (await pendingCaptures(subject))
        .filter((capture) => capture.data.appId === appId && capture.data.triggerId === triggerId)
        .map((capture) => [consentKey(capture.data), capture]),
    );
    const grantSetId = [...pendingForApp.values()]
      .map((capture) => capture.data.grantSetId)
      .find((value) => value !== undefined) ?? id("gset_");
    const missing: ApprovalRequest[] = [];
    for (const item of surface) {
      const { tool, slug } = item;
      const authored = byName.get(tool);
      if (authored === undefined) throw new VendoError("validation", `unknown tool in automation: ${tool}`);
      // The descriptor the GUARD will see at fire time, not the authored one:
      // the dispatcher's own label is `ungraded` and the broker's per-slug tag
      // arrives through the risk resolver. Grading it here is what makes the
      // consent card show the real grade AND makes the minted grant's
      // descriptorHash the one the guard recomputes on the away call — hash the
      // authored label instead and the grant is invalidated on first use.
      const descriptor = slug === undefined
        ? authored
        : withResolvedRisk(
            authored,
            await config.resolveRisk?.({ id: id("call_"), tool, args: { slug } }, authored, ctx),
          );
      if (await liveGrant(subject, appId, triggerId, descriptor, slug)) continue;
      const pending = pendingForApp.get(consentKey(item));
      if (pending !== undefined) {
        const approval = await config.store.records(APPROVALS).get(pending.id);
        const parsed = approval === null ? undefined : approvalRowSchema.safeParse(approval.data);
        if (parsed?.success === true && parsed.data.status === "pending") {
          // Adopt pre-set rows (and any stray sibling) into THE app's set so
          // one decision can settle everything outstanding.
          if (pending.data.grantSetId !== grantSetId) {
            await writeCapture(pending.id, { ...pending.data, grantSetId });
          }
          missing.push(clone(parsed.data.request));
          continue;
        }
        // A capture whose approval is gone or already decided is stale —
        // clear it and fall through to a fresh mint.
        await config.store.records(CAPTURES).delete(pending.id);
      }
      const request: ApprovalRequest = {
        id: id("apr_"),
        // The slug rides on the CALL, not on the descriptor: it is what the
        // grant is scoped to, and the descriptor is hashed.
        call: { id: id("call_"), tool, args: slug === undefined ? {} : { slug } },
        descriptor: clone(descriptor),
        inputPreview: `Allow "${doc.name}" to ${slug === undefined ? `use ${tool}` : serviceToolPhrase(slug)}`
          + " while you're away (standing, this app only)",
        ctx: {
          principal: clone(ctx.principal),
          venue: "automation",
          presence: "present",
          appId,
        },
        createdAt: iso(),
      };
      await config.store.records(APPROVALS).put({
        id: request.id,
        data: { request, status: "pending", sessionId: ctx.sessionId },
      });
      await writeCapture(request.id, {
        appId,
        triggerId,
        subject,
        tool,
        ...(slug === undefined ? {} : { slug }),
        descriptorHash: descriptorHash(descriptor),
        grantSetId,
      });
      missing.push(request);
    }
    return { missing, grantSetId };
  };

  /** The tools a consent moment covers. Steps DECLARE their surface; an agentic
   *  run declares one too when it was authored with one (`run.tools`), and falls
   *  back to every bound descriptor THE LAW would still let it reach away when it
   *  was not.
   *
   *  The connector dispatcher never enters as ITSELF, whichever kind of run this
   *  is: a tool-wide grant on it would be consent to the broker's whole catalog
   *  behind a single card. A steps run contributes one item per SERVICE ACTION it
   *  names; an agentic run contributes one per service-action slug in its
   *  declaration, which is exactly the same width. Anything either one reaches
   *  beyond that parks at fire time like any ungranted away call, and its
   *  approval accretes the per-slug grant. */
  const consentSurface = async (
    trigger: Trigger,
    byName: Map<string, ToolDescriptor>,
  ): Promise<ConsentItem[]> => {
    if (trigger.run.kind === "agentic") {
      const declared = trigger.run.tools;
      if (declared === undefined) {
        // The fallback is wide, but it is not DISHONEST: a tool §12 withholds
        // from every unattended run can never be the thing this grant permits,
        // so "allow this while you're away" is a question with no true answer.
        // The predicate is core's own `withheldFromUnattended` — the SAME one
        // `projectableForRun` filters the firing through — so the card and the
        // run cannot disagree about what may never happen away.
        return [...byName.values()]
          .filter((descriptor) => descriptor.name !== USE_SERVICE_TOOL
            && !withheldFromUnattended(descriptor))
          .map(({ name }) => ({ tool: name }));
      }
      const items = new Map<string, ConsentItem>();
      for (const name of declared) {
        // Declaring the dispatcher BY NAME buys nothing on purpose: it is the one
        // name whose tool-wide grant would be the broker's whole catalog behind a
        // single card. Name the actions instead.
        if (name === USE_SERVICE_TOOL) continue;
        // A declared name is a HOST TOOL when the bound surface has one by that
        // name, and a service action otherwise — the two namespaces are disjoint
        // by construction (bound tools match `TOOL_NAME_PATTERN`; broker slugs are
        // never bound). A name that is neither, on a deployment with no dispatcher
        // bound, enters under its OWN name so capture refuses it by that name
        // rather than as a nonsense slug.
        const item: ConsentItem = byName.has(name) || !byName.has(USE_SERVICE_TOOL)
          ? { tool: name }
          : { tool: USE_SERVICE_TOOL, slug: name };
        items.set(consentKey(item), item);
      }
      return [...items.values()];
    }
    const items = new Map<string, ConsentItem>();
    for (const tool of declaredSurface(trigger)) {
      if (tool !== USE_SERVICE_TOOL) items.set(tool, { tool });
    }
    for (const step of trigger.run.steps) {
      const slug = await declaredSlug(step);
      if (slug === undefined) continue;
      const item: ConsentItem = { tool: USE_SERVICE_TOOL, slug };
      items.set(consentKey(item), item);
    }
    return [...items.values()];
  };

  const enable: AutomationsEngine["enable"] = async (appId, triggerId, ctx) => {
    const found = await editableApp(appId, ctx);
    const trigger = declaredTrigger(found.row.doc, triggerId);
    // fn: steps run in the APP's own sandbox machine (packages/apps/src/fn.ts
    // POSTs /fn/<name> to it), not in this process — so when some other
    // authority fires this trigger, that authority is the one that has to wake
    // and reach the machine, and in v1 it may not be able to. Arming is the
    // only point that sees both the trigger kind and the steps.
    if (trigger.on.kind !== "host-event" && !firesLocally(trigger.on.kind)
      && trigger.run.kind === "steps"
      && trigger.run.steps.some((step) => step.tool.startsWith("fn:"))) {
      console.warn(
        `[vendo] automation "${found.row.doc.name}" has fn: steps but its ${trigger.on.kind} trigger fires on Vendo Cloud, `
        + "not in this process: fn: steps run in the app's own sandbox machine, which the Cloud runner may not be able to "
        + "wake or reach in v1 (those steps then settle as an error outcome). Replace them with host tools, or pass an "
        + "explicit local `store:` to createVendo to keep this composition firing its own schedule and external triggers.",
      );
    }
    const { missing, grantSetId } = await captureGrants(
      found.row.doc,
      trigger,
      await descriptors(ctx),
      ctx,
    );
    // §9.9 — enabling is what names the sponsor: the person arming an
    // automation is the person it runs as, bound to the intent they just saw.
    // A re-enable refreshes both, which is how an invalidated automation comes
    // back. Per TRIGGER, because that is the thing they just looked at and
    // allowed.
    await writeSponsorship(sponsorships(), {
      appId,
      triggerId: trigger.id,
      sponsor: ctx.principal.subject,
      ...(ctx.principal.display === undefined ? {} : { display: ctx.principal.display }),
      intentHash: currentIntentHash(found.row.doc, trigger),
      status: "active",
    });
    // The era marker outlives an erase of the sponsor, so a vanished row can
    // never be misread as "never sponsored" (§9.9 fails closed).
    await markSponsored(sponsoredEra(), appId, trigger.id, iso());
    await setArmed(appId, trigger.id, true);
    found.row.enabled = true;
    await writeApp(found.record, found.row);
    const key = triggerKey(appId, trigger.id);
    if (trigger.on.kind === "schedule") {
      const cursor = await config.store.records(SCHEDULE).get(key);
      if (cursor === null) {
        await config.store.records(SCHEDULE).put({ id: key, data: { lastFiredAt: iso() }, refs: appRef(appId) });
      }
    }
    if (trigger.on.kind === "external") {
      const secret = await config.store.records(WEBHOOK).get(key);
      if (secret === null) {
        const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
        await config.store.records(WEBHOOK).put({ id: key, data: { secret: base64url(bytes) }, refs: appRef(appId) });
      }
    }
    return { enabled: true, missing, ...(missing.length === 0 ? {} : { grantSetId }) };
  };

  const disable: AutomationsEngine["disable"] = async (appId, triggerId, ctx) => {
    const found = await editableApp(appId, ctx);
    await disarmTrigger(found.record, found.row, triggerId);
  };

  /**
   * Every sponsorship row for these apps' triggers, in ONE query — and the
   * pre-list rekey, because the LIST is where a person reads who an automation
   * runs as (§13) and whether it stopped. A row that is invisible here does not
   * merely go missing: both sentences then answer with the app's OWNER, so an
   * automation someone else took on reads as the reader's own, and a STOPPED one
   * shows no stopped line and no way back to it.
   *
   * The batch is kept. Only a `main` key that MISSED can be pre-list, and those
   * app ids are probed in one further batched read; a deployment with no pre-list
   * rows never issues it. Migration itself stays where it belongs — the one door
   * — so this consults `sponsorshipState` rather than repeating it.
   */
  const sponsorshipsFor = async (rows: readonly AppRow[]): Promise<Map<string, Sponsorship>> => {
    const keys = rows.flatMap((row) =>
      triggersOf(row.doc).map((trigger) => triggerKey(row.doc.id, trigger.id)));
    if (keys.length === 0) return new Map();
    const byTrigger = new Map<string, Sponsorship>();
    for (const record of await allRecords(sponsorships(), { ids: keys })) {
      const parsed = sponsorshipSchema.safeParse(record.data);
      if (parsed.success) byTrigger.set(triggerKey(parsed.data.appId, parsed.data.triggerId), parsed.data);
    }
    // Pair keys are `<appId>:<triggerId>` and app ids are `app_*`, so a bare app
    // id can never collide with one: this probe reads the pre-list key and only
    // the pre-list key.
    const unresolved = new Map(rows
      .filter((row) => triggersOf(row.doc).some((trigger) => trigger.id === DEFAULT_TRIGGER_ID))
      .filter((row) => !byTrigger.has(triggerKey(row.doc.id, DEFAULT_TRIGGER_ID)))
      .map((row) => [row.doc.id, row]));
    if (unresolved.size === 0) return byTrigger;
    for (const record of await allRecords(sponsorships(), { ids: [...unresolved.keys()] })) {
      const row = unresolved.get(record.id);
      if (row === undefined) continue;
      const state = await sponsorshipState(row.doc, DEFAULT_TRIGGER_ID);
      if (state.kind === "row") byTrigger.set(triggerKey(row.doc.id, DEFAULT_TRIGGER_ID), state.row);
    }
    return byTrigger;
  };

  const list: AutomationsEngine["list"] = async (ctx) => {
    const subject = ctx.principal.subject;
    const records = await allRecords(config.store.records(APPS), { refs: { subject } });
    const rows = records.map(parseAppRow).filter((row) => row.subject === subject);
    const seen = new Set(rows.map((row) => row.doc.id));
    // An ORG-held app's row subject is the org id (§9.5), so matching only the
    // caller's own subject listed a promoted automation for NOBODY — not the
    // members, not the org admin, not the person who promoted it — while promote
    // tells that person it "stays off until someone turns it back on". The orgs
    // come from the ctx (§9.1: asserted, never stored) and `can(editor)` still
    // decides each row.
    for (const org of new Set((ctx.memberships ?? []).map(({ org: id }) => id))) {
      for (const record of await allRecords(config.store.records(APPS), { refs: { subject: org } })) {
        const row = parseAppRow(record);
        if (row.subject !== org || seen.has(row.doc.id)) continue;
        if (await canEdit(ctx, row, row.doc.id)) {
          seen.add(row.doc.id);
          rows.push(row);
        }
      }
    }
    // An automation runs as its SPONSOR, who may not own the app — and the
    // person it runs as has to be able to see it (§8: editor = edit). The
    // sponsorship rows are ref'd by subject, so this is one indexed query, never
    // a scan of everybody's apps.
    //
    // INVALIDATED rows are included on purpose: a stopped automation
    // must not vanish from here, or there is no way back to it at all.
    // Deduped: sponsorship is per (app, trigger), so sponsoring two triggers of
    // one app must still fetch that app once.
    // Read with the ON-DISK schema, not the contract one: a pre-list row carries
    // no trigger id, so the strict parse dropped it and the person an automation
    // was handed to could not see it here at all. Its own rekey happens below, in
    // `sponsorshipsFor`, once the app row it names has been fetched.
    const sponsoredElsewhere = [...new Set(
      (await allRecords(sponsorships(), { refs: { subject } }))
        .map((record) => storedSponsorshipSchema.safeParse(record.data))
        .flatMap((parsed) => parsed.success ? [parsed.data.appId] : [])
        .filter((appId) => !seen.has(appId)),
    )];
    for (const record of sponsoredElsewhere.length === 0
      ? []
      : await allRecords(config.store.records(APPS), { ids: sponsoredElsewhere })) {
      const row = parseAppRow(record);
      // Sponsoring is not access: an editor whose grant was revoked keeps the
      // row but loses the door, so `can(editor)` still decides.
      if (await canEdit(ctx, row, row.doc.id)) rows.push(row);
    }
    // Pending-captures projection: an armed trigger with outstanding standing-grant
    // asks is NOT plain enabled — surfaces render "waiting on N permissions"
    // from here (reload-safe; never from an enable() result held in memory).
    // Keyed per (app, trigger), because that is the unit a person allowed.
    const outstanding = new Map<string, { pendingGrants: number; grantSetId?: string }>();
    for (const capture of await pendingCaptures(subject)) {
      const key = triggerKey(capture.data.appId, capture.data.triggerId);
      const entry = outstanding.get(key) ?? { pendingGrants: 0 };
      entry.pendingGrants += 1;
      entry.grantSetId ??= capture.data.grantSetId;
      outstanding.set(key, entry);
    }
    const automations = rows.filter((row) => triggersOf(row.doc).length > 0);
    const sponsorRows = await sponsorshipsFor(automations);
    const armed = await armedFor(automations);
    const entries: Awaited<ReturnType<AutomationsEngine["list"]>> = [];
    for (const row of automations) {
      // "…and names a wider editor set when one exists": the count comes from
      // the grants themselves, so a deployment with no access seam says nothing
      // rather than implying the automation is private. Per APP: app access is
      // not a per-trigger fact.
      const editors = config.appAccess?.list === undefined
        ? undefined
        : (await config.appAccess.list(ctx, row.doc.id)).length;
      const armedHere = new Set(armedTriggers(row, armed).map((trigger) => trigger.id));
      entries.push({
        app: row.doc,
        triggers: triggersOf(row.doc).map((trigger) => {
          const key = triggerKey(row.doc.id, trigger.id);
          const pending = outstanding.get(key);
          // §13's window label — "runs with Dana's access". The name rides the
          // sponsorship row (captured from their own Principal when they took the
          // automation on), so it reads the same for everyone; Vendo still holds no
          // directory and invents no name for anybody.
          const sponsorship = sponsorRows.get(key);
          const sponsor = sponsorship?.sponsor ?? row.subject;
          const display = sponsorship?.display ?? (sponsor === subject ? ctx.principal.display : undefined);
          // A stopped automation says so HERE, in the same sentence the
          // stopped run row uses, so the list is a way back to it rather than a
          // place it silently disappeared from.
          const stopped = sponsorship?.status === "invalidated"
            ? stopFor(sponsorship.reason ?? "edit", row.doc.name)
            : undefined;
          return {
            trigger,
            enabled: armedHere.has(trigger.id),
            sponsor: { subject: sponsor, ...(display === undefined ? {} : { display }) },
            ...(stopped === undefined ? {} : { stopped }),
            ...(pending === undefined ? {} : {
              pendingGrants: pending.pendingGrants,
              ...(pending.grantSetId === undefined ? {} : { grantSetId: pending.grantSetId }),
            }),
          };
        }),
        ...(editors === undefined ? {} : { editors }),
      });
    }
    return entries;
  };

  /** §9.9 — invalidation on a third party's edit. Called by the apps runtime
   *  after a successful persist (the `onDocumentEdit` config hook), so the
   *  choke point stays where the write already is. */
  const onDocumentEdit: AutomationsEngine["onDocumentEdit"] = async (_previous, next, editor) => {
    // Per trigger, because sponsorship is: editing one trigger must not stop the
    // app's others, and re-binding one sponsor's intent must not touch another's.
    for (const trigger of triggersOf(next)) await onTriggerEdit(next, trigger, editor);
  };

  const onTriggerEdit = async (next: AppDocument, trigger: Trigger, editor: string): Promise<void> => {
    // Through the migrating door: an edit is the other way a pre-list row can be
    // reached before its automation ever fires again, and a row nobody can see
    // is a row a third party's edit cannot invalidate.
    const state = await sponsorshipState(next, trigger.id);
    if (state.kind !== "row" || state.row.status !== "active") return;
    const row = state.row;
    if (editor !== row.sponsor) {
      await writeSponsorship(sponsorships(), {
        ...row,
        status: "invalidated",
        reason: "edit",
        invalidatedAt: iso(),
      });
      return;
    }
    // The sponsor editing their OWN automation does not invalidate sponsorship
    // (§13) — but the intent it was minted over just changed, so re-bind it
    // here. Without this the fire-time hash check would stop the automation for
    // an edit its own sponsor made, which is the same stop for the opposite
    // reason. Their GRANT set may still be invalidated by the change; that is
    // the automations-pack session's half, and it fails at the guard with a
    // card rather than here.
    const hash = currentIntentHash(next, trigger);
    if (hash !== row.intentHash) {
      await writeSponsorship(sponsorships(), { ...row, intentHash: hash });
    }
  };

  const runTick: AutomationsEngine["tick"] = async (providedNow) => {
    // Cloud (or whatever other authority) already fires schedule automations for this
    // deployment — firing them here too would double-run them. Nothing waits on a
    // decision any more, so a tick is only ever a firing path.
    if (!firesLocally("schedule")) return [];
    const at = providedNow ?? now();
    const atIso = at.toISOString();
    // Fetch only schedule-triggered apps (indexed per-kind ref) instead of scanning every
    // app for every subject, then batch every schedule cursor in one query (was an N+1 get).
    // Still ONE ref query with a trigger LIST: the ref says "this app has a schedule trigger
    // somewhere in its list", and the loop below picks out which ones.
    const appRecords = await appsFiringOn("schedule");
    const rows = appRecords.map(parseAppRow);
    const armed = await armedFor(rows);
    // Every armed schedule trigger, as (app, trigger) pairs — the unit that fires,
    // holds a cursor, and is claimed.
    const dueTriggers = rows.flatMap((row) => armedTriggers(row, armed)
      .filter((trigger) => trigger.on.kind === "schedule")
      .map((trigger) => ({ row, trigger })));
    const scheduleRecords = config.store.records(SCHEDULE);
    const cursorKeys = dueTriggers.map(({ row, trigger }) => triggerKey(row.doc.id, trigger.id));
    const cursorRecords = cursorKeys.length === 0
      ? []
      : await allRecords(scheduleRecords, { ids: cursorKeys });
    const cursorById = new Map(cursorRecords.map((record) => [record.id, record]));
    // A key that MISSED is either a schedule nobody has ever ticked or one whose
    // cursor predates the (app, trigger) rekey. The second is indistinguishable
    // from the first here, and reading it as the first restarts a running
    // automation's clock — so look for the old row before concluding anything.
    for (const record of await migratePreRekeyCursors(
      scheduleRecords,
      cursorKeys.filter((key) => !cursorById.has(key)),
    )) {
      cursorById.set(record.id, record);
    }
    const fired: FiredSchedule[] = [];
    for (const { row, trigger: declared } of dueTriggers) {
      const trigger = validateTrigger(declared);
      if (trigger.on.kind !== "schedule") continue;
      const cursorKey = triggerKey(row.doc.id, trigger.id);
      // Every write of this row restates the ref, including the compare-and-swap
      // replacement: a put that omitted it would strip the app ref the enable
      // wrote and re-orphan the cursor on the very next tick.
      const cursorRow = (data: Json) => ({ id: cursorKey, data, refs: appRef(row.doc.id) });
      const cursorRecord = cursorById.get(cursorKey) ?? null;
      const cursor = cursorRecord === null
        ? { lastFiredAt: at.toISOString() }
        : scheduleSchema.parse(cursorRecord.data);
      let scheduledFor: string | undefined;
      if (trigger.on.cron !== undefined) {
        const next = new Cron(trigger.on.cron, { timezone: "UTC", paused: true }).nextRun(new Date(cursor.lastFiredAt));
        if (next !== null && next.getTime() <= at.getTime()) scheduledFor = next.toISOString();
      } else if (trigger.on.every !== undefined) {
        const interval = durationMs(trigger.on.every) as number;
        const due = Date.parse(cursor.lastFiredAt) + interval;
        if (due <= at.getTime()) scheduledFor = new Date(due).toISOString();
      } else if (trigger.on.at !== undefined && cursor.firedAt === undefined && Date.parse(trigger.on.at) <= at.getTime()) {
        scheduledFor = trigger.on.at;
      }
      if (scheduledFor === undefined) {
        if (cursorRecord === null) {
          if (scheduleRecords.atomic === undefined) await scheduleRecords.put(cursorRow(cursor));
          else await scheduleRecords.atomic.insertIfAbsent(cursorRow(cursor));
        }
        continue;
      }
      const nextCursor = {
        ...cursor,
        lastFiredAt: at.toISOString(),
        ...(trigger.on.at === undefined ? {} : { firedAt: at.toISOString() }),
      };
      let claimed = true;
      if (cursorRecord === null) {
        if (scheduleRecords.atomic === undefined) await scheduleRecords.put(cursorRow(nextCursor));
        else claimed = await scheduleRecords.atomic.insertIfAbsent(cursorRow(nextCursor)) !== null;
      } else if (scheduleRecords.atomic !== undefined && cursorRecord.revision !== undefined) {
        claimed = await scheduleRecords.atomic.compareAndSwap(cursorRow(nextCursor), cursorRecord.revision) !== null;
      } else {
        await scheduleRecords.put(cursorRow(nextCursor));
      }
      if (!claimed) continue;
      fired.push({ row, trigger, scheduledFor, firedAt: atIso });
    }
    return await runFiredSchedules(fired);
  };

  const tick: AutomationsEngine["tick"] = (providedNow) => {
    const result = tickTail.then(() => runTick(providedNow));
    tickTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const start: AutomationsEngine["start"] = (intervalMs = 60_000) => {
    let ticking = false;
    const timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      // A failed tick must never surface as an unhandled rejection and crash the
      // host; the next interval retries.
      void tick().catch(() => undefined).finally(() => { ticking = false; });
    }, intervalMs);
    return () => clearInterval(timer);
  };

  const emit: AutomationsEngine["emit"] = async (event, payload, principal) => {
    // Ruling 2026-08-01 — an event emitted by a MEMBER of the org fires that
    // org's automations. Matching only the emitter's own subject meant an
    // ORG-owned host-event automation could never be fired by anybody: its row
    // subject is the org id (§9.5) and no principal is ever an org (§9.1 keeps
    // `kind:"org"` refused at the wire). The orgs are ASSERTED through the same
    // §9.1 seam an unattended fire uses, never stored.
    //
    // A broken directory must not take the person's OWN automations down with
    // it: the seam's failure is reported and their personal ones still fire.
    let orgs: string[] = [];
    try {
      orgs = [...new Set((await config.memberships?.(principal) ?? []).map(({ org }) => org))];
    } catch (error) {
      console.warn(
        `[vendo] could not resolve ${principal.subject}'s orgs for event "${event}" (${message(error)}); `
        + "any org-owned automation on this event did not fire — this subject's own automations did",
      );
    }
    const ids: string[] = [];
    // Indexed refs per owner (never a scan): the emitter, then each asserted org.
    for (const subject of [principal.subject, ...orgs]) {
      const records = await appsFiringOn("host-event", { subject });
      const rows = records.map(parseAppRow).filter((row) => row.subject === subject);
      const armed = await armedFor(rows);
      for (const row of rows) {
        // Every matching trigger fires, not just the first: an app may listen to
        // one event from two triggers, and they are two automations.
        for (const trigger of armedTriggers(row, armed)) {
          const source = trigger.on;
          // Membership is what makes the org's row reachable; whether this run may
          // proceed at all is the ordinary fire-time gate's call inside startRun
          // (active sponsorship + matching intent + the SPONSOR still can(editor)),
          // so an org automation nobody holds any more stops loudly instead of
          // running for whoever touched the event.
          if (source.kind === "host-event" && source.event === event) {
            ids.push(await startRun(row, trigger, "host-event", payload));
          }
        }
      }
    }
    return ids;
  };

  const envelope = (status: number, code: string, text: string): Response => Response.json(
    { error: { code, message: text } },
    { status },
  );

  const rejectWebhook = async (
    source: string,
    text: string,
    response: { status: number; code: string } = { status: 401, code: "blocked" },
  ): Promise<Response> => {
    await config.guard.report({
      id: id("aud_"),
      at: iso(),
      kind: "run",
      // Reserved namespace (block-actions design §C): runtime-minted webhook
      // principals live under `vendo:` so they can never collide with a
      // host-resolved subject.
      principal: { kind: "user", subject: webhookSubject(source) },
      venue: "automation",
      presence: "away",
      detail: { status: "webhook-rejected", reason: text },
    });
    return envelope(response.status, response.code, text);
  };

  const webhook: AutomationsEngine["webhook"] = async (request) => {
    // Cloud (or whatever other authority) already delivers external events for this
    // deployment (Composio → Cloud) — launching a run here too would double-run it. No
    // verification, no audit: this is not a rejection, just a no-op the other authority
    // is already handling.
    if (!firesLocally("external")) return Response.json({ deferred: true }, { status: 200 });
    const source = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    const headerResult = z.object({
      id: z.string().min(1),
      timestamp: z.string().regex(/^\d+$/),
      signature: z.string().regex(/^v1,.+$/),
    }).safeParse({
      id: request.headers.get("webhook-id"),
      timestamp: request.headers.get("webhook-timestamp"),
      signature: request.headers.get("webhook-signature"),
    });
    if (!headerResult.success) return await rejectWebhook(source, "invalid webhook headers");
    const oversized = { status: 413, code: "validation" };
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > WEBHOOK_MAX_BYTES) {
      return await rejectWebhook(source, "webhook body exceeds 1 MiB", oversized);
    }
    const rawBytes = await readLimitedBody(request, WEBHOOK_MAX_BYTES);
    if (rawBytes === null) return await rejectWebhook(source, "webhook body exceeds 1 MiB", oversized);
    const timestampMs = Number(headerResult.data.timestamp) * 1_000;
    if (!Number.isSafeInteger(timestampMs) || Math.abs(now().getTime() - timestampMs) > 300_000) {
      return await rejectWebhook(source, "webhook timestamp is outside the allowed window");
    }
    // Standard-Webhooks senders may send several space-separated signatures
    // (key rotation): accept the delivery if ANY v1 candidate verifies.
    const signatures = headerResult.data.signature
      .split(/\s+/)
      .filter((entry) => entry.startsWith("v1,"))
      .map((entry) => entry.slice(3));
    const signed = signedWebhookBytes(headerResult.data.id, headerResult.data.timestamp, rawBytes);
    const appRecords = await allRecords(config.store.records(APPS));
    const rows = appRecords.map(parseAppRow);
    const armed = await armedFor(rows);
    // Verified per (app, TRIGGER): each external trigger holds its own secret, so
    // a signature that verifies for one says nothing about a sibling's.
    const verified: Array<{ row: AppRow; trigger: Trigger }> = [];
    for (const row of rows) {
      for (const trigger of armedTriggers(row, armed)) {
        if (trigger.on.kind !== "external" || trigger.on.connector !== source) continue;
        const secretRecord = await config.store.records(WEBHOOK).get(triggerKey(row.doc.id, trigger.id));
        if (secretRecord === null) continue;
        const secret = webhookSchema.safeParse(secretRecord.data);
        if (!secret.success) continue;
        let matched = false;
        for (const candidate of signatures) {
          if (await verifySignature(secret.data.secret, candidate, signed)) {
            matched = true;
            break;
          }
        }
        if (matched) verified.push({ row, trigger });
      }
    }
    if (verified.length === 0) return await rejectWebhook(source, "webhook signature verification failed");
    let body: Json;
    try {
      body = JSON.parse(new TextDecoder().decode(rawBytes)) as Json;
    } catch {
      return envelope(400, "validation", "webhook body must be valid JSON");
    }
    const ids: string[] = [];
    let deduped = 0;
    for (const { row, trigger } of verified) {
      // Dedupe per (app, trigger, delivery): one delivery may legitimately fire
      // two of an app's triggers, and neither is a duplicate of the other.
      const deliveryKey = `${triggerKey(row.doc.id, trigger.id)}:${headerResult.data.id}`;
      if (inFlightDeliveries.has(deliveryKey)) {
        deduped += 1;
        continue;
      }
      inFlightDeliveries.add(deliveryKey);
      try {
        const deliveries = config.store.records(DELIVERIES);
        const delivery = {
          id: deliveryKey,
          data: {
            appId: row.doc.id,
            triggerId: trigger.id,
            deliveryId: headerResult.data.id,
            receivedAt: iso(),
          },
          refs: appRef(row.doc.id),
        };
        if (deliveries.atomic === undefined) {
          if (await deliveries.get(deliveryKey) !== null) {
            deduped += 1;
            continue;
          }
          await deliveries.put(delivery);
        } else if (await deliveries.atomic.insertIfAbsent(delivery) === null) {
          deduped += 1;
          continue;
        }
        ids.push(await startRun(row, trigger, "external", body));
      } finally {
        inFlightDeliveries.delete(deliveryKey);
      }
    }
    if (ids.length === 0 && deduped > 0) return Response.json({ deduped: true }, { status: 200 });
    return Response.json({ runIds: ids }, { status: 200 });
  };

  const dryRun: AutomationsEngine["dryRun"] = async (appId, triggerId, ctx, event) => {
    const found = await editableApp(appId, ctx);
    const trigger = declaredTrigger(found.row.doc, triggerId);
    const byName = await descriptors(ctx);
    const plan: RunPlan = { steps: [], grantsMissing: [] };
    const add = async (stepId: string, tool: string): Promise<void> => {
      if (tool.startsWith("fn:")) {
        plan.steps.push({ id: stepId, tool, wouldAsk: false });
        return;
      }
      const descriptor = byName.get(tool);
      if (descriptor === undefined) throw new VendoError("validation", `unknown tool in automation: ${tool}`);
      const granted = await liveGrant(found.row.subject, appId, triggerId, descriptor);
      plan.steps.push({ id: stepId, tool, wouldAsk: descriptor.confirmEach === true || !granted });
      if (!descriptor.confirmEach && !granted && !plan.grantsMissing.includes(tool)) plan.grantsMissing.push(tool);
    };
    if (trigger.run.kind === "agentic") {
      for (const descriptor of byName.values()) await add(descriptor.name, descriptor.name);
      return plan;
    }
    const outputs: Record<string, Json> = {};
    for (const step of trigger.run.steps) {
      if (event === undefined) {
        await add(step.id, step.tool);
        continue;
      }
      try {
        if (step.if !== undefined && !await evaluate(step.if, { event, steps: outputs, item: undefined })) continue;
        if (step.forEach === undefined) {
          await stepArgs(step, event, outputs);
          await add(step.id, step.tool);
          continue;
        }
        const items = validateForEachItems(
          step,
          await evaluate(step.forEach, { event, steps: outputs, item: undefined }),
        );
        for (const item of items) {
          await stepArgs(step, event, outputs, item);
          await add(step.id, step.tool);
        }
      } catch {
        // Nothing executes in a dry run, so `steps.<id>` outputs stay empty —
        // expressions over them cannot expand. Degrade to the static entry
        // rather than failing the preview.
        await add(step.id, step.tool);
      }
    }
    return plan;
  };

  const runsGet: AutomationsEngine["runs"]["get"] = async (runId, ctx) => {
    const stored = await config.store.records(RUNS).get(runId);
    if (stored === null) return null;
    const run = parseRunRecord(stored);
    // §8 editor = edit: the person the automation RUNS AS sees its history, not
    // only the app's owner. Ownership-only when no access seam is configured.
    return await editableAppOrNull(run.appId, ctx) === null ? null : publicRun(run);
  };

  const runsList: AutomationsEngine["runs"]["list"] = async (filter, ctx) => {
    // Scope BEFORE paginating: filtering after the page both under-fills pages
    // and leaks a cursor (an existence oracle) to non-viewers.
    if (filter.appId !== undefined && await editableAppOrNull(filter.appId, ctx) === null) {
      return { runs: [] };
    }
    const refs = {
      ...(filter.appId === undefined ? {} : { app_id: filter.appId }),
      ...(filter.status === undefined ? {} : { status: filter.status }),
    };
    const runs: RunRecord[] = [];
    const visible = new Map<string, boolean>();
    let cursor = filter.cursor;
    // Without an appId scope, walk store pages until a page is filled with the
    // caller's runs — bounded so a foreign-heavy table cannot be scanned
    // unboundedly. Each fetch asks for exactly the remaining page budget, so
    // the store cursor always sits at the consumption boundary: pages never
    // overfill and the returned cursor never skips rows.
    for (let pages = 0; pages < 20 && runs.length < RUNS_PAGE_LIMIT; pages += 1) {
      const page = await config.store.records(RUNS).list({
        refs,
        limit: RUNS_PAGE_LIMIT - runs.length,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const stored of page.records) {
        const run = parseRunRecord(stored);
        // The trigger filter is applied HERE rather than as a store ref: runs are
        // indexed by app and status, and a run row's trigger id lives inside its
        // record. The page walk below already tolerates an under-filled page.
        if (filter.triggerId !== undefined && run.triggerId !== filter.triggerId) continue;
        let mine = visible.get(run.appId);
        if (mine === undefined) {
          mine = await editableAppOrNull(run.appId, ctx) !== null;
          visible.set(run.appId, mine);
        }
        if (mine) runs.push(publicRun(run));
      }
      cursor = page.cursor;
      if (cursor === undefined) break;
    }
    return { runs, ...(cursor === undefined ? {} : { cursor }) };
  };

  const runsStop: AutomationsEngine["runs"]["stop"] = async (runId, ctx) => {
    const stored = await config.store.records(RUNS).get(runId);
    if (stored === null) throw new VendoError("not-found", `run not found: ${runId}`);
    const run = parseRunRecord(stored);
    const app = await editableAppOrNull(run.appId, ctx);
    if (app === null) throw new VendoError("not-found", `run not found: ${runId}`);
    if (run.status !== "running") {
      throw new VendoError("conflict", `run cannot be stopped from status ${run.status}`);
    }
    stopped.add(runId);
    abortControllers.get(runId)?.abort();
    const runCtx = await runContext(app.row.doc, run, app.row.subject);
    await terminal(run, runCtx, "stopped", "stopped by user");
    if (!active.has(runId)) stopped.delete(runId);
  };

  /** Run it again. The remedy a fail-loud run leaves behind: whoever granted the
   *  missing permission taps this and the automation fires again from the top,
   *  on the same event, against LIVE data.
   *
   *  It is a FRESH run and not a continuation on purpose — nothing mid-run is
   *  restored, nothing is replayed. Safety for the work the first attempt did
   *  land is the guard's effect ledger's job (build contract §7), not a
   *  bookkeeping layer here.
   *
   *  Gated exactly like `stop`: anyone who can edit the app, existence-masked
   *  for anyone who cannot. A trigger nobody has armed is refused rather than
   *  fired — "run it again" may not be a way to run something switched off. */
  const runsRerun: AutomationsEngine["runs"]["rerun"] = async (runId, ctx) => {
    const stored = await config.store.records(RUNS).get(runId);
    if (stored === null) throw new VendoError("not-found", `run not found: ${runId}`);
    const run = parseRunRecord(stored);
    const app = await editableAppOrNull(run.appId, ctx);
    if (app === null) throw new VendoError("not-found", `run not found: ${runId}`);
    const declared = triggerOf(app.row.doc, run.triggerId);
    if (declared === undefined) {
      throw new VendoError("conflict", `app has no trigger "${run.triggerId}" any more`);
    }
    if (!await isArmed(app.row, run.triggerId)) {
      throw new VendoError("conflict", "this automation is off — turn it on to run it again");
    }
    // A run row from before the event was persisted has nothing to re-fire.
    // Refused rather than fired on an invented empty event: the steps' own
    // JSONata reads `event.*`, so an empty payload is a different run.
    if (run.__event === undefined) {
      throw new VendoError("conflict", "this run is from before re-runs were possible");
    }
    // The ROOT of the firing, so re-running a re-run keeps one lineage instead of
    // a chain: every run of this firing then shares one effect ledger, and the
    // second re-run still sees what the first already completed.
    // The definition that FIRED, not the one declared now: `declared` above is
    // what proves the trigger still exists and is armed, but firing an edited
    // step list under the original lineage would move a completed call's
    // positional id off its own receipt and run it a second time.
    const { runId: freshId, done } = launchRun(
      app.row,
      run.__trigger ?? declared,
      run.trigger.kind,
      run.__event,
      (run.__lineage ?? run.id) as RunId,
    );
    await done;
    return freshId;
  };

  return {
    enable,
    disable,
    list,
    tick,
    start,
    emit,
    webhook,
    runs: { get: runsGet, list: runsList, stop: runsStop, rerun: runsRerun },
    dryRun,
    onDocumentEdit,
  };
};
