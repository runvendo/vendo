import {
  VendoError,
  approvalRequestSchema,
  appDocumentSchema,
  descriptorHash,
  permissionGrantSchema,
  triggerSchema,
  webhookSubject,
  type AppDocument,
  type ApprovalRequest,
  type AuditEvent,
  type Json,
  type PermissionGrant,
  type Principal,
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
import { adoptionCard, type AdoptionCard } from "./adoption.js";
import {
  claimSponsorship,
  currentIntentHash,
  declaredSurface,
  markSponsored,
  readSponsorship,
  SPONSORED,
  SPONSORSHIPS,
  sponsorName,
  sponsorshipSchema,
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
const PARKED = "automations:parked";
const RESUME_CLAIMS = "automations:resume-claims";
const SCHEDULE = "automations:schedule";
const WEBHOOK = "automations:webhook";
const DELIVERIES = "automations:deliveries";
const WEBHOOK_MAX_BYTES = 1024 * 1024;
const RESUME_MAX_BYTES = 512 * 1024;
const FOREACH_MAX_ITEMS = 1000;

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
  subject: z.string(),
  tool: z.string(),
  descriptorHash: z.string(),
  /** The grant SET this pending ask belongs to (07 §3 grant capture; one
   *  enable() = one set). Optional: rows minted before sets existed have
   *  none and are adopted into the app's set on the next enable(). */
  grantSetId: z.string().optional(),
});

const parkedSchema = z.object({ runId: z.string() });
const scheduleSchema = z.object({ lastFiredAt: z.string(), firedAt: z.string().optional() });
const webhookSchema = z.object({ secret: z.string() });

interface AppRow {
  subject: string;
  enabled: boolean;
  doc: AppDocument;
}

interface ResumeState {
  stepIndex: number;
  forEachIndex?: number;
  event: Json;
  stepOutputs: Record<string, Json>;
  call: ToolCall;
  approvalId: string;
  iterationItems?: Json[];
  iterationOutputs?: Json[];
  claimedBy?: string;
}

interface InternalRunRecord extends RunRecord {
  __resume?: ResumeState;
}

const resumeSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  forEachIndex: z.number().int().nonnegative().optional(),
  event: z.unknown(),
  stepOutputs: z.record(z.unknown()),
  call: z.object({ id: z.string(), tool: z.string(), args: z.unknown() }),
  approvalId: z.string(),
  iterationItems: z.array(z.unknown()).optional(),
  iterationOutputs: z.array(z.unknown()).optional(),
  claimedBy: z.string().optional(),
});

const runStatusSchema = z.enum(["running", "ok", "error", "stopped", "pending-approval"]);

const baseRunRecordSchema = z.object({
  id: z.string(),
  appId: z.string(),
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
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

const internalRunRecordSchema = baseRunRecordSchema.extend({ __resume: resumeSchema.optional() });

interface RunRowData {
  appId: string;
  trigger: RunRecord["trigger"];
  status: RunStatus;
  record: InternalRunRecord;
  startedAt: string;
  finishedAt?: string;
}

const runRowDataSchema = z.object({
  appId: z.string(),
  trigger: baseRunRecordSchema.shape.trigger,
  status: runStatusSchema,
  record: internalRunRecordSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
});

/** Every stop sentence ends the same way, and must: the list, the adoption card
 *  and the stopped run row all print it, and they have to match byte for byte. */
const TAKE_IT_ON = " — anyone who can edit this app can take it on";

/** §9.9 — what a stopped automation says, in the consumer's voice. It names the
 *  automation and what anyone who can edit the app may do about it; the
 *  machinery (hashes, grants, principals) stays out of the sentence.
 *
 *  It never names the SPONSOR, and that is a durability rule rather than a
 *  style one: this sentence is PERSISTED on the run row, `vendo_runs` has no
 *  subject column (02-store §2), and the erase cascade reaches run rows only
 *  through the apps the subject OWNS — which for an org-owned automation is the
 *  org, and the org outlives the person (§9.7). A name written here would
 *  therefore survive its owner's own erasure. The name belongs on the adoption
 *  card and the audit row instead: both are derived from rows the cascade does
 *  reach. */
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

/** §9.9 + F10 — what a run says when the identity checks could not ANSWER (the
 *  host's memberships callback or access seam threw). The raw failure is a host
 *  system's error text — a DSN, a stack, a driver message — and the run row is
 *  rendered verbatim to consumers (`automations-panel.tsx` prints `summary` and
 *  `error.message`), so it says what happened and nothing about how. The raw
 *  detail goes to the audit row, which is where an operator looks. */
const IDENTITY_UNAVAILABLE = (name: string): string =>
  `stopped: ${name} could not check who it runs as — nothing ran, and it will try again on its next trigger`;

const IDENTITY_UNAVAILABLE_RESUME =
  "stopped: this run could not check who it runs as — nothing further ran; run it again to continue";

/** Captures are a GENERIC collection, and the 02-store §5 erase cascade finds
 *  generic rows by their refs — so an unref'd capture outlives both the person
 *  who was asked and the app that asked. (Approvals need none: `vendo_approvals`
 *  is reserved, derives its own refs, and is erased by its subject column.) */
const captureRefs = (subject: string, appId: string): Record<string, string> =>
  ({ subject, app_id: appId });

/** §9.9 — what a run says when the automation changed hands while it waited. The
 *  automation itself is fine; it is this RUN that belongs to a sponsor who no
 *  longer holds it, and re-running is the whole remedy. Anonymous for the same
 *  durability reason as {@link SPONSORSHIP_STOP}: it is persisted on a run row
 *  no subject erase can reach. */
const SPONSOR_CHANGED =
  "stopped: this run was waiting with the access of the person who used to run it,"
  + " which has changed — run it again to continue";

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

const parseRunRow = (record: VendoRecord): RunRowData => {
  const result = runRowDataSchema.safeParse(record.data);
  if (!result.success) throw new VendoError("validation", `invalid run row ${record.id}: ${result.error.issues[0]?.message ?? "invalid"}`);
  return result.data as unknown as RunRowData;
};

// Callers already validated the row via parseRunRow; only __resume needs stripping.
const publicRun = ({ __resume: _, ...record }: InternalRunRecord): RunRecord => record;

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
  delete target.__resume;
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
  const resuming = new Set<string>();
  const inFlightDeliveries = new Set<string>();
  const abortControllers = new Map<string, AbortController>();
  // Minted on first claim, not at construction: Workers forbids generating
  // random values in global scope, and createVendo composes this engine at
  // module init in the edge wiring.
  let engineInstanceId: string | undefined;
  const instanceId = (): string => (engineInstanceId ??= globalThis.crypto.randomUUID());
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
   *  editor = edit, and §13's adoption makes an editor the person an automation
   *  runs as, so arming, disarming and previewing are theirs too — not the
   *  owner's alone. With no access seam configured this is exactly the ownership
   *  check it replaces. */
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

  const writeApp = async (record: VendoRecord, row: AppRow): Promise<void> => {
    // trigger_kind lets the tick/emit fetch apps by trigger kind (the reserved store derives it
    // from a column and ignores caller refs; a generic StoreAdapter honors what we pass here).
    await config.store.records(APPS).put({
      id: record.id,
      data: row,
      refs: {
        subject: row.subject,
        ...(row.doc.trigger === undefined ? {} : { trigger_kind: row.doc.trigger.on.kind }),
      },
    });
  };

  // `ctx` rides through so the projection seam (design §12) is not silently
  // dropped here. Both callers — enable and dryRun — are PRESENT-time
  // ceremonies, so nothing is withheld: the owner must still see and grant
  // everything the automation declares, and dryRun must still explain it.
  const descriptors = async (ctx?: RunContext): Promise<Map<string, ToolDescriptor>> =>
    new Map((await config.tools.descriptors(ctx)).map((descriptor) => [descriptor.name, descriptor]));

  const liveGrant = async (
    subject: string,
    appId: string,
    descriptor: ToolDescriptor,
  ): Promise<boolean> => {
    const records = await allRecords(config.store.records(GRANTS), {
      refs: { subject, tool: descriptor.name, app_id: appId },
    });
    const at = now().getTime();
    return records.some((record) => {
      const parsed = permissionGrantSchema.safeParse(record.data);
      if (!parsed.success) return false;
      const grant = parsed.data;
      return grant.subject === subject
        && grant.tool === descriptor.name
        && grant.descriptorHash === descriptorHash(descriptor)
        && grant.appId === appId
        && grant.source === "automation"
        && grant.duration === "standing"
        && grant.scope.kind === "tool"
        && grant.revokedAt === undefined
        && (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > at);
    });
  };

  const audit = async (ctx: RunContext, status: string, extra: Record<string, Json> = {}): Promise<void> => {
    const event: AuditEvent = {
      id: id("aud_"),
      at: iso(),
      kind: "run",
      principal: ctx.principal,
      venue: "automation",
      presence: "away",
      ...(ctx.appId === undefined ? {} : { appId: ctx.appId }),
      ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
      detail: { status, ...extra },
    };
    await config.guard.report(event);
  };

  const writeRun = async (record: InternalRunRecord): Promise<boolean> => {
    const stored = await config.store.records(RUNS).get(record.id);
    if (stored !== null) {
      const current = parseRunRow(stored).record;
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
   *  the app was sponsored once — the fact that its sponsor was ERASED. */
  const sponsorshipState = async (
    appId: string,
  ): Promise<
    | { kind: "none" }
    | { kind: "erased" }
    | { kind: "row"; row: Sponsorship; revision?: string }
  > => {
    const found = await readSponsorship(sponsorships(), appId);
    if (found !== undefined) return { kind: "row", ...found };
    return await wasSponsored(sponsoredEra(), appId) ? { kind: "erased" } : { kind: "none" };
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
   *  still audits under (F10: a fire that cannot even resolve who it runs as
   *  must leave a record, not vanish). */
  const baseRunContext = (run: InternalRunRecord, subject: string): RunContext => ({
    principal: { kind: "user", subject },
    venue: "automation",
    presence: "away",
    sessionId: `sess_${run.id}`,
    appId: run.appId,
    trigger: { runId: run.id, kind: run.trigger.kind },
  });

  /** §9.9 — the run's identity is its SPONSOR: an automation always runs as a
   *  named person. The app row's subject is the fallback for automations armed
   *  before sponsorship existed, and for a sponsorship that has lapsed (the
   *  fire-time gate below stops those runs anyway). */
  const runContext = async (run: InternalRunRecord, subject: string): Promise<RunContext> => {
    const sponsorship = await readSponsorship(sponsorships(), run.appId);
    const ctx = baseRunContext(
      run,
      sponsorship?.row.status === "active" ? sponsorship.row.sponsor : subject,
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
   *  invalidated — which IS the adoption card (the card is derived state, not a
   *  second row) — and the caller stops the run loudly before any tool call. */
  const sponsorshipRefusal = async (
    app: AppRow,
    ctx: RunContext,
  ): Promise<{ reason: NonNullable<Sponsorship["reason"]>; summary: string } | undefined> => {
    const state = await sponsorshipState(app.doc.id);
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
    if (row.intentHash !== currentIntentHash(app.doc)) return await invalidate("edit");
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
    error?: { code: string; message: string },
  ): Promise<void> => {
    delete run.__resume;
    run.status = status;
    run.finishedAt = iso();
    run.summary = summary;
    if (error === undefined) delete run.error;
    else run.error = error;
    if (await writeRun(run)) await audit(ctx, status);
  };

  const park = async (
    run: InternalRunRecord,
    ctx: RunContext,
    state: ResumeState,
  ): Promise<void> => {
    if (new TextEncoder().encode(JSON.stringify(state)).byteLength > RESUME_MAX_BYTES) {
      await terminal(
        run,
        ctx,
        "error",
        `stopped at ${run.steps.at(-1)?.id ?? "step"}: persisted resume state exceeds 512 KiB`,
        { code: "validation", message: "persisted resume state exceeds 512 KiB" },
      );
      return;
    }
    run.status = "pending-approval";
    run.summary = `stopped at ${run.steps.at(-1)?.id ?? "step"}: approval required`;
    run.__resume = clone(state);
    if (!await writeRun(run)) return;
    await config.store.records(PARKED).put({ id: state.approvalId, data: { runId: run.id } });
    await audit(ctx, "pending-approval");
  };

  const appendOutcome = (run: InternalRunRecord, step: Step, outcome: ToolOutcome): void => {
    run.steps.push({
      id: step.id,
      tool: step.tool,
      outcome: outcome.status,
      at: iso(),
      ...(outcomeDetail(outcome) === undefined ? {} : { detail: outcomeDetail(outcome) }),
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
      const current = parseRunRow(stored).record;
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

  const continueSteps = async (
    app: AppRow,
    trigger: Trigger,
    run: InternalRunRecord,
    ctx: RunContext,
    state: {
      stepIndex: number;
      event: Json;
      stepOutputs: Record<string, Json>;
      iterationItems?: Json[];
      iterationOutputs?: Json[];
      forEachIndex?: number;
    },
  ): Promise<void> => {
    if (trigger.run.kind !== "steps") throw new VendoError("validation", "steps run expected");
    const steps = trigger.run.steps;
    for (let stepIndex = state.stepIndex; stepIndex < steps.length; stepIndex += 1) {
      if (await finishStoppedIfNeeded(run)) return;
      const step = steps[stepIndex] as Step;
      let items: Json[] | undefined = stepIndex === state.stepIndex ? state.iterationItems : undefined;
      let outputs: Json[] = stepIndex === state.stepIndex ? state.iterationOutputs ?? [] : [];
      let iterationStart = stepIndex === state.stepIndex ? state.forEachIndex ?? 0 : 0;
      try {
        if (items === undefined) {
          if (step.if !== undefined && !await evaluate(step.if, { event: state.event, steps: state.stepOutputs, item: undefined })) {
            continue;
          }
          if (step.forEach !== undefined) {
            const evaluated = await evaluate(step.forEach, { event: state.event, steps: state.stepOutputs, item: undefined });
            items = validateForEachItems(step, evaluated);
          }
        }
      } catch (error) {
        await failStep(run, ctx, step, error);
        return;
      }

      const iterations: Array<{ item?: Json; index?: number }> = items === undefined
        ? [{}]
        : items.map((item, index) => ({ item, index }));
      for (let index = iterationStart; index < iterations.length; index += 1) {
        if (await finishStoppedIfNeeded(run)) return;
        const iteration = iterations[index] as { item?: Json; index?: number };
        let args: Record<string, Json>;
        try {
          args = await stepArgs(step, state.event, state.stepOutputs, iteration.item);
        } catch (error) {
          await failStep(run, ctx, step, error);
          return;
        }
        const call: ToolCall = { id: id("call_"), tool: step.tool, args };
        const outcome = await executeCall(app.doc.id, step, call, ctx);
        if (await finishStoppedIfNeeded(run)) return;
        appendOutcome(run, step, outcome);
        if (outcome.status === "pending-approval") {
          await park(run, ctx, {
            stepIndex,
            ...(items === undefined ? {} : { forEachIndex: index, iterationItems: items, iterationOutputs: outputs }),
            event: state.event,
            stepOutputs: state.stepOutputs,
            call,
            approvalId: outcome.approvalId,
          });
          return;
        }
        if (outcome.status !== "ok") {
          const error = errorForOutcome(outcome);
          await terminal(run, ctx, "error", `stopped at ${step.id}: ${error.message}`, error);
          return;
        }
        if (items === undefined) state.stepOutputs[step.id] = outcome.output;
        else outputs.push(outcome.output);
      }
      if (items !== undefined) state.stepOutputs[step.id] = outputs;
      state.iterationItems = undefined;
      state.iterationOutputs = undefined;
      state.forEachIndex = undefined;
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
      const report = await config.runner({
        prompt: trigger.run.prompt,
        tools: config.tools,
        budget: { maxToolCalls: trigger.run.budget?.maxToolCalls ?? 50 },
        abortSignal,
      }, ctx);
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
  const launchRun = (app: AppRow, kind: TriggerSource["kind"], event: Json): { runId: RunId; done: Promise<void> } => {
    const trigger = validateTrigger(app.doc.trigger);
    const runId = id("run_");
    const startedAt = iso();
    const record: InternalRunRecord = {
      id: runId,
      appId: app.doc.id,
      trigger: {
        kind,
        ...(triggerEvent(trigger.on) === undefined ? {} : { event: triggerEvent(trigger.on) }),
      },
      status: "running",
      startedAt,
      steps: [],
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
          ctx = await runContext(record, app.subject);
          stop = await sponsorshipRefusal(app, ctx);
        } catch (error) {
          // F10 — the consumer sentence and the operator's detail part ways
          // here: `summary` is rendered verbatim in the automations panel, so
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
            await continueSteps(app, trigger, record, ctx, { stepIndex: 0, event, stepOutputs: {} });
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

  const startRun = async (app: AppRow, kind: TriggerSource["kind"], event: Json): Promise<RunId> => {
    const { runId, done } = launchRun(app, kind, event);
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
  const runFiredSchedules = async (
    fired: Array<{ row: AppRow; scheduledFor: string; firedAt: string }>,
  ): Promise<RunId[]> => {
    const concurrency = Math.max(1, Math.floor(config.tickConcurrency ?? 4));
    const timeoutMs = config.runTimeoutMs;
    const ids: Array<RunId | undefined> = new Array(fired.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= fired.length) return;
        const entry = fired[index] as { row: AppRow; scheduledFor: string; firedAt: string };
        let launched: { runId: RunId; done: Promise<void> };
        try {
          launched = launchRun(entry.row, "schedule", { scheduledFor: entry.scheduledFor, firedAt: entry.firedAt });
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

  const mintGrant = async (request: ApprovalRequest): Promise<string> => {
    const grant: PermissionGrant = {
      id: id("grt_"),
      subject: request.ctx.principal.subject,
      tool: request.call.tool,
      descriptorHash: descriptorHash(request.descriptor),
      scope: { kind: "tool" },
      duration: "standing",
      ...(request.ctx.appId === undefined ? {} : { appId: request.ctx.appId }),
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

  const resumeRun = async (approvalId: string, approved: boolean): Promise<void> => {
    const dropPark = (): Promise<void> => config.store.records(PARKED).delete(approvalId);
    const parkedRecord = await config.store.records(PARKED).get(approvalId);
    if (parkedRecord === null) return;
    const { runId } = parkedSchema.parse(parkedRecord.data);
    if (resuming.has(runId)) return;
    resuming.add(runId);
    try {
      const stored = await config.store.records(RUNS).get(runId);
      if (stored === null) {
        await dropPark();
        return;
      }
      const run = parseRunRow(stored).record;
      if (run.status !== "pending-approval" || run.__resume?.approvalId !== approvalId) {
        if (run.status === "running" && run.__resume?.approvalId === approvalId && run.__resume.claimedBy !== undefined) {
          return;
        }
        await dropPark();
        return;
      }
      const approval = await config.store.records(APPROVALS).get(approvalId);
      if (approval === null) return;
      const approvalData = approvalRowSchema.parse(approval.data);

      const claimedBy = `${instanceId()}:${globalThis.crypto.randomUUID()}`;
      const claims = config.store.records(RESUME_CLAIMS);
      const atomicClaim = claims.atomic === undefined
        ? undefined
        : await claims.atomic.insertIfAbsent({
          id: approvalId,
          data: { runId, claimedBy, claimedAt: iso() },
        });
      if (claims.atomic !== undefined && atomicClaim === null) return;

      run.status = "running";
      delete run.summary;
      run.__resume.claimedBy = claimedBy;
      if (!await writeRun(run)) return;
      if (claims.atomic === undefined) {
        // Optional-capability fallback: preserve the prior single-instance behavior.
        // The unique write/read narrows, but cannot close, a cross-process race.
        const claimedRecord = await config.store.records(RUNS).get(runId);
        if (claimedRecord === null) return;
        const claimedRun = parseRunRow(claimedRecord).record;
        if (claimedRun.status !== "running" || claimedRun.__resume?.claimedBy !== claimedBy) return;
        syncRun(run, claimedRun);
      }

      const appFound = await appRecord(run.appId);
      if (appFound === null) {
        // The app is gone, so there is no sponsorship left to resolve and no
        // seam worth asking — the approval's own subject is the honest voice for
        // this terminal row, and it cannot throw.
        const ctx = baseRunContext(run, approvalData.request.ctx.principal.subject);
        await terminal(run, ctx, "stopped", "app deleted before resume");
        await dropPark();
        return;
      }
      // The run is already CLAIMED ("running"), so an identity seam that throws
      // here must not strand it: land the loud terminal row under the row
      // subject instead (F10, the resume half).
      let ctx: RunContext;
      try {
        ctx = await runContext(run, appFound.row.subject);
      } catch (error) {
        const fallback = baseRunContext(run, appFound.row.subject);
        // F10 again, the resume half: the raw throw is the audit row's, and the
        // consumer reads a sentence about their automation.
        await audit(fallback, "sponsorship-check-failed", {
          summary: IDENTITY_UNAVAILABLE_RESUME,
          detail: message(error),
        });
        await terminal(run, fallback, "error", IDENTITY_UNAVAILABLE_RESUME, {
          code: "error",
          message: IDENTITY_UNAVAILABLE_RESUME,
        });
        await dropPark();
        return;
      }
      if (!appFound.row.enabled || appFound.row.doc.trigger === undefined) {
        await terminal(run, ctx, "stopped", "automation disabled before resume");
        await dropPark();
        return;
      }
      if (await finishStoppedIfNeeded(run)) {
        await dropPark();
        return;
      }
      await audit(ctx, "running");
      if (!approved) {
        const state = run.__resume;
        const pending = [...run.steps].reverse().find(
          (entry) => entry.outcome === "pending-approval" && entry.detail === approvalId,
        );
        if (pending !== undefined) {
          pending.outcome = "blocked";
          pending.detail = "user declined approval";
          pending.at = iso();
        }
        const declinedStepId = state !== undefined && appFound.row.doc.trigger.run.kind === "steps"
          ? appFound.row.doc.trigger.run.steps[state.stepIndex]?.id ?? "step"
          : "step";
        await terminal(run, ctx, "error", `stopped at ${declinedStepId}: user declined`, {
          code: "blocked",
          message: "the user declined the approval",
        });
        await dropPark();
        return;
      }
      const state = run.__resume as ResumeState;
      // The run is claimed (status "running", claimedBy persisted) from here on: a throw
      // escaping this section would strand it in "running" forever (re-entry short-circuits
      // on the claim and sweepParked only scans "pending-approval"), so any resume failure
      // must land the run on a terminal row instead.
      let trigger: Trigger;
      let step: Step;
      let outcome: ToolOutcome;
      // Hoisted so the catch can take the grant back too: a throw between the
      // mint and the dispatch would otherwise strand exactly the standing
      // authority this section exists to keep from outliving its yes.
      let armed: string | undefined;
      try {
        // §9.9 — the fire-time gate AGAIN, here, because a resume is a second
        // firing through a different door: the run parked, time passed, and the
        // document it is about to act on is re-read from the store. Without this
        // a third party could edit the automation while the run sat parked and
        // have the SPONSOR's identity execute the edited call on approval
        // (proved: inv_42 → inv_EVIL as user_dana). A throw from the seams lands
        // on the catch below, which is why it sits inside this block.
        const refusal = await sponsorshipRefusal(appFound.row, ctx);
        if (refusal !== undefined) {
          await audit(ctx, "sponsorship-invalidated", { reason: refusal.reason, summary: refusal.summary });
          await terminal(run, ctx, "error", refusal.summary, { code: "blocked", message: refusal.summary });
          await dropPark();
          return;
        }
        // …and the gate above is not enough on its own, because it asks about
        // the automation NOW while this run belongs to an earlier era. An
        // adoption completing between park and resume satisfies every current
        // check — active sponsorship, matching intent, an editor who can edit —
        // yet the parked approval belongs to the sponsor who is gone: resuming it
        // would execute a call the new sponsor never saw under THEIR identity,
        // against an intent that may no longer contain that step, and mint the
        // grant under the OLD sponsor. A run may only be resumed by the very
        // person who was asked, so a changed hand ends it: nothing runs, nothing
        // is granted, and the automation simply runs again from the top.
        const parked = approvalData.request.ctx.principal;
        if (parked.subject !== ctx.principal.subject) {
          await audit(ctx, "sponsorship-changed", { parked: parked.subject, summary: SPONSOR_CHANGED });
          await terminal(run, ctx, "error", SPONSOR_CHANGED, { code: "blocked", message: SPONSOR_CHANGED });
          await dropPark();
          return;
        }
        trigger = validateTrigger(appFound.row.doc.trigger);
        if (trigger.run.kind !== "steps") throw new VendoError("validation", "parked agentic run is invalid");
        const parkedStep = trigger.run.steps[state.stepIndex];
        if (parkedStep === undefined) throw new VendoError("validation", "parked step is missing");
        step = parkedStep;
        // This path cannot call `spendApproval`: the REPLAY below is the spend,
        // on the same `consumed:<id>` transition, and one approval cannot be
        // spent twice (a pre-spend makes the guard refuse its own replay and the
        // step re-parks forever — verified against the confirmEach resume case).
        // The grant must also exist BEFORE the dispatch: an away call acts as the
        // user only through captured authority (05 §6). So the grant is minted
        // first and TAKEN BACK when the replay did not win — the receipt is the
        // arbiter, which is the only thing that can tell "the person revoked it
        // mid-resume" from "we read the row a moment too early". Deleted rather
        // than tombstoned with a `revokedAt`, symmetric with the mint (which
        // writes no audit event either): a revoked-grant row for authority the
        // person never actually held would read as history that did not happen.
        //
        // KNOWN LIMIT — this holds for every outcome the process lives through,
        // including a throw, but NOT for a crash between the mint and the
        // take-back: a kill there leaves the grant behind, and nothing sweeps it.
        // It is visible in `grants.list`, pinned to this tool's `descriptorHash`,
        // app-bound and away-only, and the person can revoke it. Closing it needs
        // the mint and the delete in one transaction, which the store's
        // record-at-a-time seam does not offer.
        armed = await mintGrant(approvalData.request);
        outcome = await executeCall(run.appId, step, state.call, ctx);
        if (outcome.status === "pending-approval" || outcome.status === "blocked") {
          await config.store.records(GRANTS).delete(armed);
        }
      } catch (error) {
        // Same law as a refused replay: the yes was never spent, so it leaves no
        // standing authority. Best-effort — a failed delete must not replace the
        // real failure below with its own.
        if (armed !== undefined) {
          await config.store.records(GRANTS).delete(armed).catch(() => undefined);
        }
        await terminal(run, ctx, "error", `stopped at resume: ${message(error)}`, {
          code: "validation",
          message: message(error),
        });
        await dropPark();
        return;
      }
      if (await finishStoppedIfNeeded(run)) {
        await dropPark();
        return;
      }
      const pending = [...run.steps].reverse().find(
        (entry) => entry.outcome === "pending-approval" && entry.detail === approvalId,
      );
      if (pending !== undefined) {
        pending.outcome = outcome.status;
        // An explicit undefined property is not JSON — drop the key instead.
        const detail = outcomeDetail(outcome);
        if (detail === undefined) delete pending.detail;
        else pending.detail = detail;
        pending.at = iso();
      } else appendOutcome(run, step, outcome);
      if (outcome.status === "pending-approval") {
        state.approvalId = outcome.approvalId;
        delete state.claimedBy;
        await dropPark();
        await park(run, ctx, state);
        return;
      }
      if (outcome.status !== "ok") {
        const error = errorForOutcome(outcome);
        await terminal(run, ctx, "error", `stopped at ${step.id}: ${error.message}`, error);
        await dropPark();
        return;
      }
      if (state.iterationItems === undefined) state.stepOutputs[step.id] = outcome.output;
      else (state.iterationOutputs ??= []).push(outcome.output);
      delete run.__resume;
      if (!await writeRun(run)) {
        await dropPark();
        return;
      }
      await dropPark();
      await continueSteps(appFound.row, trigger, run, ctx, {
        stepIndex: state.iterationItems === undefined ? state.stepIndex + 1 : state.stepIndex,
        event: state.event,
        stepOutputs: state.stepOutputs,
        ...(state.iterationItems === undefined ? {} : {
          iterationItems: state.iterationItems,
          iterationOutputs: state.iterationOutputs,
          forEachIndex: (state.forEachIndex ?? 0) + 1,
        }),
      });
    } finally {
      resuming.delete(runId);
    }
  };

  /** Whether the app holds ANY live automation-source standing grant — the
   *  evidence a consent moment granted the automation something. */
  const anyLiveAutomationGrant = async (subject: string, appId: string): Promise<boolean> => {
    const records = await allRecords(config.store.records(GRANTS), { refs: { subject, app_id: appId } });
    const at = now().getTime();
    return records.some((record) => {
      const result = permissionGrantSchema.safeParse(record.data);
      if (!result.success) return false;
      const grant = result.data;
      return grant.subject === subject
        && grant.appId === appId
        && grant.source === "automation"
        && grant.duration === "standing"
        && grant.scope.kind === "tool"
        && grant.revokedAt === undefined
        && (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > at);
    });
  };

  const handleDecision = async (approvalId: string, approved: boolean): Promise<void> => {
    const capture = await config.store.records(CAPTURES).get(approvalId);
    if (capture !== null) {
      const parsed = captureSchema.parse(capture.data);
      const approval = await config.store.records(APPROVALS).get(approvalId);
      if (approved && approval !== null) {
        const data = approvalRowSchema.parse(approval.data);
        // Spend before granting: a yes the person took back at this instant
        // must arm nothing, and only one of the two can win the transition.
        if (await spendApproval(approval)) await mintGrant(data.request);
      }
      await config.store.records(CAPTURES).delete(approvalId);
      if (!approved) {
        // Deny is transactional at the DECISION (criterion 19, deny half),
        // but disarms ONLY a consent moment that ended with NOTHING granted:
        // no capture asks left pending for the app and no live
        // automation-source grant held. A partially granted automation stays
        // armed — its ungranted steps park at fire time (05 §6, J5), exactly
        // the pre-set behavior.
        const outstanding = (await pendingCaptures(parsed.subject))
          .some((candidate) => candidate.data.appId === parsed.appId);
        if (!outstanding && !(await anyLiveAutomationGrant(parsed.subject, parsed.appId))) {
          const found = await appRecord(parsed.appId);
          if (found !== null && found.row.subject === parsed.subject && found.row.enabled) {
            found.row.enabled = false;
            await writeApp(found.record, found.row);
          }
        }
      }
      return;
    }
    if (await config.store.records(PARKED).get(approvalId) !== null) {
      await resumeRun(approvalId, approved);
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
      // AgentRunReport has no continuation token in v0. Approval arms the
      // app-bound authority for the next agentic firing instead of replaying
      // and duplicating the completed prefix of an agent run.
      if (await spendApproval(approval)) await mintGrant(data.request);
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
  const pendingCaptures = async (subject: string): Promise<Array<{ id: string; data: z.infer<typeof captureSchema> }>> => {
    const records = await allRecords(config.store.records(CAPTURES));
    const captures: Array<{ id: string; data: z.infer<typeof captureSchema> }> = [];
    for (const record of records) {
      const parsed = captureSchema.safeParse(record.data);
      if (parsed.success && parsed.data.subject === subject) captures.push({ id: record.id, data: parsed.data });
    }
    return captures;
  };

  /** The tools a consent moment has to ask THIS subject about: the automation's
   *  surface minus whatever they already hold a live standing grant for.
   *
   *  Two callers, one routine (07 §3): enable(), where the owner arms the
   *  automation, and adopt() (§9.9), where an editor takes a stopped one on —
   *  approving its reads and writes AS THEMSELVES, which is exactly the same
   *  capture under a different subject. */
  const captureGrants = async (
    doc: AppDocument,
    surface: readonly string[],
    byName: Map<string, ToolDescriptor>,
    ctx: RunContext,
  ): Promise<{ missing: ApprovalRequest[]; grantSetId: string }> => {
    const appId = doc.id;
    const subject = ctx.principal.subject;
    // One grant SET per automation: re-enables reuse the app's still-pending
    // asks (and their set id) instead of minting duplicates for the same
    // (appId, tool); a fresh set id is minted only when nothing is pending.
    const pendingForApp = new Map(
      (await pendingCaptures(subject))
        .filter((capture) => capture.data.appId === appId)
        .map((capture) => [capture.data.tool, capture]),
    );
    const grantSetId = [...pendingForApp.values()]
      .map((capture) => capture.data.grantSetId)
      .find((value) => value !== undefined) ?? id("gset_");
    const missing: ApprovalRequest[] = [];
    for (const tool of surface) {
      const descriptor = byName.get(tool);
      if (descriptor === undefined) throw new VendoError("validation", `unknown tool in automation: ${tool}`);
      if (await liveGrant(subject, appId, descriptor)) continue;
      const pending = pendingForApp.get(tool);
      if (pending !== undefined) {
        const approval = await config.store.records(APPROVALS).get(pending.id);
        const parsed = approval === null ? undefined : approvalRowSchema.safeParse(approval.data);
        if (parsed?.success === true && parsed.data.status === "pending") {
          // Adopt pre-set rows (and any stray sibling) into THE app's set so
          // one decision can settle everything outstanding.
          if (pending.data.grantSetId !== grantSetId) {
            await config.store.records(CAPTURES).put({
              id: pending.id,
              data: { ...pending.data, grantSetId },
              refs: captureRefs(pending.data.subject, pending.data.appId),
            });
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
        call: { id: id("call_"), tool, args: {} },
        descriptor: clone(descriptor),
        inputPreview: `Allow "${doc.name}" to use ${tool} while you're away (standing, this app only)`,
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
      await config.store.records(CAPTURES).put({
        id: request.id,
        data: { appId, subject, tool, descriptorHash: descriptorHash(descriptor), grantSetId },
        refs: captureRefs(subject, appId),
      });
      missing.push(request);
    }
    return { missing, grantSetId };
  };

  /** The tools a consent moment covers. Steps DECLARE their surface; without a
   *  model seat, agentic capture conservatively exposes every bound descriptor
   *  (PR flag, unchanged). */
  const consentSurface = (trigger: Trigger, byName: Map<string, ToolDescriptor>): string[] =>
    trigger.run.kind === "steps" ? declaredSurface(trigger) : [...byName.keys()];

  const enable: AutomationsEngine["enable"] = async (appId, ctx) => {
    const found = await editableApp(appId, ctx);
    if (found.row.doc.trigger === undefined) throw new VendoError("validation", "app has no trigger");
    const trigger = validateTrigger(found.row.doc.trigger);
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
    const byName = await descriptors(ctx);
    const { missing, grantSetId } = await captureGrants(
      found.row.doc,
      consentSurface(trigger, byName),
      byName,
      ctx,
    );
    // §9.9 — enabling is what names the sponsor: the person arming an
    // automation is the person it runs as, bound to the intent they just saw.
    // A re-enable refreshes both, which is how an invalidated automation its
    // OWNER re-arms comes back without an adoption card.
    await writeSponsorship(sponsorships(), {
      appId,
      sponsor: ctx.principal.subject,
      ...(ctx.principal.display === undefined ? {} : { display: ctx.principal.display }),
      intentHash: currentIntentHash(found.row.doc),
      status: "active",
    });
    // The era marker outlives an erase of the sponsor, so a vanished row can
    // never be misread as "never sponsored" (§9.9 fails closed).
    await markSponsored(sponsoredEra(), appId, iso());
    found.row.enabled = true;
    await writeApp(found.record, found.row);
    if (trigger.on.kind === "schedule") {
      const cursor = await config.store.records(SCHEDULE).get(appId);
      if (cursor === null) {
        await config.store.records(SCHEDULE).put({ id: appId, data: { lastFiredAt: iso() } });
      }
    }
    if (trigger.on.kind === "external") {
      const secret = await config.store.records(WEBHOOK).get(appId);
      if (secret === null) {
        const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
        await config.store.records(WEBHOOK).put({ id: appId, data: { secret: base64url(bytes) } });
      }
    }
    return { enabled: true, missing, ...(missing.length === 0 ? {} : { grantSetId }) };
  };

  const disable: AutomationsEngine["disable"] = async (appId, ctx) => {
    const found = await editableApp(appId, ctx);
    found.row.enabled = false;
    await writeApp(found.record, found.row);
  };

  /** Every sponsorship row for a set of apps, in ONE query. */
  const sponsorshipsFor = async (appIds: string[]): Promise<Map<string, Sponsorship>> => {
    if (appIds.length === 0) return new Map();
    const rows = await allRecords(sponsorships(), { ids: appIds });
    const byApp = new Map<string, Sponsorship>();
    for (const record of rows) {
      const parsed = sponsorshipSchema.safeParse(record.data);
      if (parsed.success) byApp.set(parsed.data.appId, parsed.data);
    }
    return byApp;
  };

  const list: AutomationsEngine["list"] = async (ctx) => {
    const subject = ctx.principal.subject;
    const records = await allRecords(config.store.records(APPS), { refs: { subject } });
    const rows = records.map(parseAppRow).filter((row) => row.subject === subject);
    const seen = new Set(rows.map((row) => row.doc.id));
    // E8-F1 — an ORG-held app's row subject is the org id (§9.5), so matching
    // the caller's own subject listed a promoted automation for NOBODY: not the
    // members, not the org admin, not even the person who promoted it. Promote
    // deliberately disarms the automation and tells the promoter it "stays off
    // until someone turns it back on" — a promise nothing could keep while the
    // only surface that mentions it hid it. The orgs come from the ctx (§9.1:
    // asserted, never stored) and `can(editor)` still decides each row.
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
    // An adopted automation runs as its SPONSOR, who may not own the app — and
    // the person it runs as has to be able to see it (§8: editor = edit). The
    // sponsorship rows are ref'd by subject, so this is one indexed query, never
    // a scan of everybody's apps.
    //
    // E8-F2 — INVALIDATED rows are included on purpose. A stopped automation
    // used to vanish from here, leaving the adoption card the only mention of it
    // anywhere: dismiss the card, or never open the app, and there was no way
    // back to it at all.
    const sponsoredElsewhere = (await allRecords(sponsorships(), { refs: { subject } }))
      .map((record) => sponsorshipSchema.safeParse(record.data))
      .filter((parsed) => parsed.success)
      .map((parsed) => (parsed as { data: Sponsorship }).data.appId)
      .filter((appId) => !seen.has(appId));
    for (const record of sponsoredElsewhere.length === 0
      ? []
      : await allRecords(config.store.records(APPS), { ids: sponsoredElsewhere })) {
      const row = parseAppRow(record);
      // Sponsoring is not access: an editor whose grant was revoked keeps the
      // row but loses the door, so `can(editor)` still decides.
      if (await canEdit(ctx, row, row.doc.id)) rows.push(row);
    }
    // Pending-captures projection: an enabled row with outstanding standing-grant
    // asks is NOT plain enabled — surfaces render "waiting on N permissions"
    // from here (reload-safe; never from an enable() result held in memory).
    const outstanding = new Map<string, { pendingGrants: number; grantSetId?: string }>();
    for (const capture of await pendingCaptures(subject)) {
      const entry = outstanding.get(capture.data.appId) ?? { pendingGrants: 0 };
      entry.pendingGrants += 1;
      entry.grantSetId ??= capture.data.grantSetId;
      outstanding.set(capture.data.appId, entry);
    }
    const automations = rows.filter((row) => row.doc.trigger !== undefined);
    const sponsorRows = await sponsorshipsFor(automations.map((row) => row.doc.id));
    const entries: Awaited<ReturnType<AutomationsEngine["list"]>> = [];
    for (const row of automations) {
      const pending = outstanding.get(row.doc.id);
      // §13's window label — "runs with Dana's access". The name rides the
      // sponsorship row (captured from their own Principal when they took the
      // automation on), so it reads the same for everyone; Vendo still holds no
      // directory and invents no name for anybody.
      const sponsorship = sponsorRows.get(row.doc.id);
      const sponsor = sponsorship?.sponsor ?? row.subject;
      const display = sponsorship?.display ?? (sponsor === subject ? ctx.principal.display : undefined);
      // "…and names a wider editor set when one exists": the count comes from
      // the grants themselves, so a deployment with no access seam says nothing
      // rather than implying the automation is private.
      const editors = config.appAccess?.list === undefined
        ? undefined
        : (await config.appAccess.list(ctx, row.doc.id)).length;
      // E8-F2 — a stopped automation says so HERE, in the same sentence the
      // adoption card and the stopped run row use, so the list is a way back to
      // it rather than a place it silently disappeared from.
      const stopped = sponsorship?.status === "invalidated"
        ? stopFor(sponsorship.reason ?? "edit", row.doc.name)
        : undefined;
      entries.push({
        app: row.doc,
        enabled: row.enabled,
        sponsor: { subject: sponsor, ...(display === undefined ? {} : { display }) },
        ...(stopped === undefined ? {} : { stopped }),
        ...(editors === undefined ? {} : { editors }),
        ...(pending === undefined ? {} : {
          pendingGrants: pending.pendingGrants,
          ...(pending.grantSetId === undefined ? {} : { grantSetId: pending.grantSetId }),
        }),
      });
    }
    return entries;
  };

  /** §9.9 — invalidation on a third party's edit. Called by the apps runtime
   *  after a successful persist (the `onDocumentEdit` config hook), so the
   *  choke point stays where the write already is. */
  const onDocumentEdit: AutomationsEngine["onDocumentEdit"] = async (_previous, next, editor) => {
    const found = await readSponsorship(sponsorships(), next.id);
    if (found === undefined || found.row.status !== "active") return;
    if (editor !== found.row.sponsor) {
      await writeSponsorship(sponsorships(), {
        ...found.row,
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
    const hash = currentIntentHash(next);
    if (hash !== found.row.intentHash) {
      await writeSponsorship(sponsorships(), { ...found.row, intentHash: hash });
    }
  };

  const adoption: AutomationsEngine["adoption"] = async (appId, ctx) => {
    const state = await sponsorshipState(appId);
    const waiting = state.kind === "erased"
      // The sponsor's row was erased with their data: the ask is real, and it is
      // anonymous — the name went with the erase and must not come back.
      ? { reason: "departure" as const, sponsor: undefined }
      : state.kind === "row" && state.row.status === "invalidated"
        ? { reason: state.row.reason ?? "edit", sponsor: sponsorName(state.row) }
        : undefined;
    if (waiting === undefined) return undefined;
    // Served ONLY to editors+: a viewer sees the app, not the ask. Nothing is
    // pushed to anybody — the card waits here for whoever opens the app next.
    const found = await editableAppOrNull(appId, ctx);
    if (found === null) return undefined;
    return adoptionCard(
      found.row.doc,
      {
        reason: waiting.reason,
        ...(waiting.sponsor === undefined ? {} : { sponsor: waiting.sponsor }),
        ...(state.kind === "row" && state.row.invalidatedAt !== undefined
          ? { stoppedAt: state.row.invalidatedAt }
          : {}),
      },
      await descriptors(ctx),
    );
  };

  const adopt: AutomationsEngine["adopt"] = async (appId, ctx) => {
    const found = await editableApp(appId, ctx);
    const state = await sponsorshipState(appId);
    // Adoptable from either stopped shape: an invalidated row, or an erased
    // sponsor who left no row behind.
    const claimable = state.kind === "erased"
      || (state.kind === "row" && state.row.status === "invalidated");
    if (!claimable) return { adopted: false, missing: [], reason: "already-adopted" };
    if (found.row.doc.trigger === undefined) throw new VendoError("validation", "app has no trigger");
    const trigger = validateTrigger(found.row.doc.trigger);
    const byName = await descriptors(ctx);
    // Approvals stay strictly SELF-SUBJECT: the adopter approves the
    // automation's reads and writes as themselves, through the existing
    // approvals door, and the grant set is minted under their subject.
    const { missing, grantSetId } = await captureGrants(
      found.row.doc,
      consentSurface(trigger, byName),
      byName,
      ctx,
    );
    const swapped = await claimSponsorship(sponsorships(), {
      appId,
      sponsor: ctx.principal.subject,
      ...(ctx.principal.display === undefined ? {} : { display: ctx.principal.display }),
      intentHash: currentIntentHash(found.row.doc),
      status: "active",
    }, state.kind === "erased"
      ? { kind: "erased" }
      : { kind: "row", ...(state.revision === undefined ? {} : { revision: state.revision }) });
    // First editor+ to complete wins; the loser is told the truth rather than
    // silently overwriting the winner. Their own asks stand — they are that
    // person's standing grants for an app they can edit, and the engine already
    // projects them as "waiting on N permissions".
    if (!swapped) return { adopted: false, missing: [], reason: "already-adopted" };
    return { adopted: true, missing, ...(missing.length === 0 ? {} : { grantSetId }) };
  };

  const sweepParked = async (): Promise<void> => {
    const runs = await allRecords(config.store.records(RUNS), { refs: { status: "pending-approval" } });
    for (const record of runs) {
      const run = parseRunRow(record).record;
      const approvalId = run.__resume?.approvalId;
      if (approvalId === undefined) continue;
      const approval = await config.store.records(APPROVALS).get(approvalId);
      if (approval === null) continue;
      const decision = approvalRowSchema.safeParse(approval.data);
      if (!decision.success || decision.data.status === "pending") continue;
      await resumeRun(approvalId, decision.data.status === "approved");
    }
  };

  const runTick: AutomationsEngine["tick"] = async (providedNow) => {
    await sweepParked();
    // Cloud (or whatever other authority) already fires schedule automations for this
    // deployment — firing them here too would double-run them. Approval resumption
    // (sweepParked, above) is not a firing path, so it stays unconditional.
    if (!firesLocally("schedule")) return [];
    const at = providedNow ?? now();
    const atIso = at.toISOString();
    // Fetch only schedule-triggered apps (indexed trigger_kind ref) instead of scanning every
    // app for every subject, then batch every schedule cursor in one query (was an N+1 get).
    const appRecords = await allRecords(config.store.records(APPS), { refs: { trigger_kind: "schedule" } });
    const rows = appRecords
      .map(parseAppRow)
      .filter((row) => row.enabled && row.doc.trigger?.on.kind === "schedule");
    const scheduleRecords = config.store.records(SCHEDULE);
    const cursorRecords = rows.length === 0
      ? []
      : await allRecords(scheduleRecords, { ids: rows.map((row) => row.doc.id) });
    const cursorById = new Map(cursorRecords.map((record) => [record.id, record]));
    const fired: Array<{ row: AppRow; scheduledFor: string; firedAt: string }> = [];
    for (const row of rows) {
      const trigger = validateTrigger(row.doc.trigger);
      if (trigger.on.kind !== "schedule") continue;
      const cursorRecord = cursorById.get(row.doc.id) ?? null;
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
          if (scheduleRecords.atomic === undefined) await scheduleRecords.put({ id: row.doc.id, data: cursor });
          else await scheduleRecords.atomic.insertIfAbsent({ id: row.doc.id, data: cursor });
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
        if (scheduleRecords.atomic === undefined) await scheduleRecords.put({ id: row.doc.id, data: nextCursor });
        else claimed = await scheduleRecords.atomic.insertIfAbsent({ id: row.doc.id, data: nextCursor }) !== null;
      } else if (scheduleRecords.atomic !== undefined && cursorRecord.revision !== undefined) {
        claimed = await scheduleRecords.atomic.compareAndSwap(
          { id: row.doc.id, data: nextCursor },
          cursorRecord.revision,
        ) !== null;
      } else {
        await scheduleRecords.put({ id: row.doc.id, data: nextCursor });
      }
      if (!claimed) continue;
      fired.push({ row, scheduledFor, firedAt: atIso });
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
      for (const record of await allRecords(config.store.records(APPS), {
        refs: { subject, trigger_kind: "host-event" },
      })) {
        const row = parseAppRow(record);
        const source = row.doc.trigger?.on;
        // Membership is what makes the org's row reachable; whether this run may
        // proceed at all is the ordinary fire-time gate's call inside startRun
        // (active sponsorship + matching intent + the SPONSOR still can(editor)),
        // so an org automation nobody holds any more stops loudly instead of
        // running for whoever touched the event.
        if (row.enabled && row.subject === subject && source?.kind === "host-event" && source.event === event) {
          ids.push(await startRun(row, "host-event", payload));
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
    const verified: AppRow[] = [];
    for (const record of appRecords) {
      const row = parseAppRow(record);
      const trigger = row.doc.trigger?.on;
      if (!row.enabled || trigger?.kind !== "external" || trigger.connector !== source) continue;
      const secretRecord = await config.store.records(WEBHOOK).get(row.doc.id);
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
      if (matched) verified.push(row);
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
    for (const row of verified) {
      const deliveryKey = `${row.doc.id}:${headerResult.data.id}`;
      if (inFlightDeliveries.has(deliveryKey)) {
        deduped += 1;
        continue;
      }
      inFlightDeliveries.add(deliveryKey);
      try {
        const deliveries = config.store.records(DELIVERIES);
        const delivery = {
          id: deliveryKey,
          data: { appId: row.doc.id, deliveryId: headerResult.data.id, receivedAt: iso() },
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
        ids.push(await startRun(row, "external", body));
      } finally {
        inFlightDeliveries.delete(deliveryKey);
      }
    }
    if (ids.length === 0 && deduped > 0) return Response.json({ deduped: true }, { status: 200 });
    return Response.json({ runIds: ids }, { status: 200 });
  };

  const dryRun: AutomationsEngine["dryRun"] = async (appId, ctx, event) => {
    const found = await editableApp(appId, ctx);
    if (found.row.doc.trigger === undefined) throw new VendoError("validation", "app has no trigger");
    const trigger = validateTrigger(found.row.doc.trigger);
    const byName = await descriptors(ctx);
    const plan: RunPlan = { steps: [], grantsMissing: [] };
    const add = async (stepId: string, tool: string): Promise<void> => {
      if (tool.startsWith("fn:")) {
        plan.steps.push({ id: stepId, tool, wouldAsk: false });
        return;
      }
      const descriptor = byName.get(tool);
      if (descriptor === undefined) throw new VendoError("validation", `unknown tool in automation: ${tool}`);
      const granted = await liveGrant(found.row.subject, appId, descriptor);
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
    const run = parseRunRow(stored).record;
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
        const run = parseRunRow(stored).record;
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
    const run = parseRunRow(stored).record;
    const app = await editableAppOrNull(run.appId, ctx);
    if (app === null) throw new VendoError("not-found", `run not found: ${runId}`);
    if (run.status !== "running" && run.status !== "pending-approval") {
      throw new VendoError("conflict", `run cannot be stopped from status ${run.status}`);
    }
    stopped.add(runId);
    abortControllers.get(runId)?.abort();
    const parkedApprovalId = run.__resume?.approvalId;
    const runCtx = await runContext(run, app.row.subject);
    await terminal(run, runCtx, "stopped", "stopped by user");
    if (parkedApprovalId !== undefined) await config.store.records(PARKED).delete(parkedApprovalId);
    if (!active.has(runId)) stopped.delete(runId);
  };

  return {
    enable,
    disable,
    list,
    tick,
    start,
    emit,
    webhook,
    runs: { get: runsGet, list: runsList, stop: runsStop },
    dryRun,
    onDocumentEdit,
    adoption,
    adopt,
  };
};
