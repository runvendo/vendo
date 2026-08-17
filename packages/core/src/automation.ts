/**
 * The automation RECORD — first-class, principal-owned, and free of every app
 * concept: `@vendoai/automations` depends on this module and on nothing else
 * that knows what an app is (dependency-guard enforces the edge).
 *
 * It lives in core because four authoring doors and two packages have to name
 * the same shapes: the chat tool (`vendo_automate`), `vendo_make`'s auto-arm
 * sugar and the `vendo.json` manifest fold-in (both in `@vendoai/apps`), and
 * `agent.on` (`@vendoai/agents`). `@vendoai/apps` may import core and nothing
 * else, so this is the only place all four can meet.
 */
import { Cron } from "croner";
import { z } from "zod";
import { VendoError } from "./errors.js";
import { isoDateTimeSchema, type IsoDateTime } from "./ids.js";
import { canonicalJson } from "./jcs.js";
import { principalSchema, type Principal } from "./principal.js";
import type { RunContext } from "./run-context.js";
import { sha256Hex } from "./sha256.js";
import { stepSchema, triggerSourceSchema, type Step, type TriggerSource } from "./triggers.js";

/** `atm_<32 hex>` when minted, `atm_<hash of when+task+agent>` or
 *  `atm_<declared id>` when a code/manifest declaration names its own identity —
 *  the identity a reconcile matches on. */
export type AutomationId = string;

/** The inline budget shape `RunModel` used to carry, named because four surfaces
 *  now pass it by name. */
export interface Budget {
  maxToolCalls?: number;
}

/** The AUTHORING input — all five `.on()` shapes and the chat tool's `when`.
 *  A bare string is a cron expression, validated at declaration. */
export type When =
  | string
  | { every: string }
  | { at: IsoDateTime }
  | { event: string }
  | { webhook: string };

/** What a record RUNS. `"goal"` goes to the named runner; `"steps"` runs in the
 *  engine's own process. */
export type AutomationTask =
  | { kind: "goal"; prompt: string; budget?: Budget }
  | { kind: "steps"; steps: Step[] };

/**
 * THE record.
 *
 * INVARIANT: no app reference of any kind. A task reaches an app only by naming
 * one of its functions as an ordinary granted tool inside `task`, so an app that
 * is deleted fails at tool resolution — loudly, in the run ledger — rather than
 * leaving a dangling field here.
 */
export interface AutomationRecord {
  id: AutomationId;
  owner: Principal;
  when: TriggerSource;
  task: AutomationTask;
  /** Runner-map name. Absent → {@link DEFAULT_RUNNER_NAME}. Steps never carry one. */
  agent?: string;
  armed: boolean;
  authoredBy: "chat" | "code" | "manifest";
  /** Cron/`every` are evaluated in this zone; absent → UTC. */
  timezone?: string;
  /** The grant SET this record's standing grants belong to, so one decision can
   *  settle every ask. The grants themselves are `vendo_grants` rows keyed to
   *  `automation_id` — never inlined here. */
  grantSetId?: string;
  /** External records only: the standard-webhooks HMAC key, base64url, minted at
   *  create. Redacted by list/get; only the webhook door reads it. */
  webhookSecret?: string;
  /** Set when a PERSON disarmed it. {@link reconcileAutomations} never re-arms a
   *  record carrying this — the manual kill switch survives every redeploy. */
  disarmedBy?: "user";
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** The budget shape, beside its interface like every other core schema. */
export const budgetSchema = z.object({
  maxToolCalls: z.number().optional(),
}).passthrough() satisfies z.ZodType<Budget>;

export const automationTaskSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("goal"),
    prompt: z.string(),
    budget: budgetSchema.optional(),
  }).passthrough(),
  z.object({
    kind: z.literal("steps"),
    steps: z.array(stepSchema),
  }).passthrough(),
]) satisfies z.ZodType<AutomationTask>;

export const automationRecordSchema = z.object({
  id: z.string(),
  owner: principalSchema,
  when: triggerSourceSchema,
  task: automationTaskSchema,
  agent: z.string().optional(),
  armed: z.boolean(),
  authoredBy: z.enum(["chat", "code", "manifest"]),
  timezone: z.string().optional(),
  grantSetId: z.string().optional(),
  webhookSecret: z.string().optional(),
  disarmedBy: z.literal("user").optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).passthrough() satisfies z.ZodType<AutomationRecord>;

/** THE one create operation, as a type — the implementation is
 *  `create-surface.ts` in `@vendoai/automations`, reached through
 *  `automationsInternals(engine)` and never exposed on `vendo.automations`.
 *  Named here so `@vendoai/apps` can hold one without an illegal import. */
export type CreateAutomation = (
  input: CreateAutomationInput,
  ctx: RunContext,
) => Promise<AutomationRecord>;

export interface CreateAutomationInput {
  /** Declared identity. Absent → minted. Present and already stored → that
   *  record is REPLACED, which is what makes a redeploy idempotent. */
  id?: AutomationId;
  owner: Principal;
  when: When;
  task: AutomationTask;
  agent?: string;
  timezone?: string;
  authoredBy: AutomationRecord["authoredBy"];
  /** `false` creates it disarmed; absent → armed. */
  armed?: boolean;
}

/** Where a rejected declaration sends its author. The docs are their own host —
 *  `vendo.run/docs/**` is a 404, so a refusal built on it sends the developer to
 *  a dead page. */
export const AUTOMATIONS_DOCS_URL = "https://docs.vendo.run/capabilities/automations";

/** `<n><s|m|h|d>`, or null. The tick reads it too, so it is stated once here
 *  rather than once per package. */
export const durationMs = (value: string): number | null => {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (match === null) return null;
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const units = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  return count * units[match[2] as keyof typeof units];
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** The nearest valid cron for the words somebody wrote. Best-effort by design:
 *  the point is to hand back something they can paste, not to parse English. */
const didYouMean = (text: string): string => {
  const lower = text.toLowerCase();
  const day = WEEKDAYS.findIndex((name) => lower.includes(name));
  if (day >= 0) return `0 9 * * ${day}`;
  if (lower.includes("month")) return "0 9 1 * *";
  if (lower.includes("hour")) return "0 * * * *";
  if (lower.includes("minute")) return "* * * * *";
  return "0 9 * * *";
};

const invalid = (what: string, why: string, suggestion: string): never => {
  throw new VendoError(
    "validation",
    `${what} — ${why}. Did you mean ${suggestion}? See ${AUTOMATIONS_DOCS_URL}`,
  );
};

/** A cron expression, or a `validation` throw naming the nearest valid one. */
const validateCron = (cron: string): string => {
  if (cron.trim().split(/\s+/).length !== 5) {
    invalid(`"${cron}" is not a cron expression`, "a cron expression has exactly 5 fields", `"${didYouMean(cron)}"`);
  }
  try {
    new Cron(cron, { timezone: "UTC", paused: true });
  } catch (error) {
    invalid(
      `"${cron}" is not a valid cron expression`,
      error instanceof Error ? error.message : String(error),
      `"${didYouMean(cron)}"`,
    );
  }
  return cron;
};

/**
 * The ONE converter from the authoring shape to the stored one. All four
 * authoring doors call it, so a cron nobody can run is refused at DECLARATION —
 * synchronously, before the process serves anything — rather than at 2am.
 */
export function toTriggerSource(when: When): TriggerSource {
  if (typeof when === "string") return { kind: "schedule", cron: validateCron(when) };
  if ("every" in when) {
    if (durationMs(when.every) === null) {
      invalid(`"${when.every}" is not an interval`, "an interval is <n><s|m|h|d> with n > 0", '{ every: "1d" }');
    }
    return { kind: "schedule", every: when.every };
  }
  if ("at" in when) {
    if (!Number.isFinite(Date.parse(when.at))) {
      invalid(`"${when.at}" is not a date-time`, "at takes an ISO 8601 instant", '{ at: "2026-09-01T09:00Z" }');
    }
    return { kind: "schedule", at: when.at };
  }
  if ("event" in when) {
    if (when.event === "") invalid("the event name is empty", "a host event is named", '{ event: "payment.failed" }');
    return { kind: "host-event", event: when.event };
  }
  // The webhook arm is the FALL-THROUGH, so it has to prove the key is there
  // rather than merely non-empty: absent is not empty, and an object with none of
  // the five keys — which is what an untyped wire body is — used to walk in here
  // and leave with `connector: undefined`, an automation nothing can ever trigger
  // that its owner is nonetheless shown as armed.
  if (!("webhook" in when)) {
    invalid(
      "this names no trigger",
      "a trigger is a cron string, or one of { every }, { at }, { event }, { webhook }",
      '{ every: "1d" }',
    );
  }
  if (when.webhook === "") invalid("the webhook name is empty", "a webhook names its connector", '{ webhook: "stripe" }');
  return { kind: "external", connector: when.webhook };
}

/**
 * The content identity of a record: sha256 over the RFC 8785 canonical form of
 * what it DOES.
 *
 * One hash, two jobs, and they must not disagree. It mints the default id for a
 * declaration (so editing the cron or the words is a NEW automation and the old
 * one is disarmed), and it is the intent an owner's sponsorship is bound to (so
 * a record whose content changed under a live sponsorship stops loudly).
 */
export function automationHash(
  content: { when: TriggerSource; task: AutomationTask; agent?: string; timezone?: string },
): string {
  return sha256Hex(canonicalJson({
    agent: content.agent ?? null,
    task: content.task as unknown,
    timezone: content.timezone ?? null,
    when: content.when,
  }));
}

/** What `.on()` and the manifest fold-in collected. */
export interface DeclaredAutomation {
  /** Stable identity; absent → {@link automationHash}. */
  id?: string;
  when: When;
  task: AutomationTask;
  agent?: string;
  timezone?: string;
}

export interface ReconcilePlan {
  /** New, and changed (the changed one's new identity). */
  create: CreateAutomationInput[];
  /** Removed from code, and the superseded identities of changed ones. Consent
   *  was the code; the code no longer says it, so it is DISARMED — never
   *  deleted, so its run history survives. */
  disarm: AutomationId[];
}

/** The id a declaration takes: its own name, or its content hash. */
export const declaredAutomationId = (declared: DeclaredAutomation, when: TriggerSource): AutomationId =>
  declared.id === undefined
    ? `atm_${automationHash({ ...declared, when }).slice(0, 12)}`
    : `atm_${declared.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

/**
 * Declared-vs-stored, as a pure diff — no I/O, no store, no engine. `agent.on`'s
 * boot reconcile and the `vendo.json` manifest fold-in both drive the engine's
 * create/disable operations from this ONE plan.
 *
 * `stored` is filtered to the same author and owner before diffing: a code
 * reconcile never touches a chat-authored record. A record a PERSON disarmed is
 * left alone entirely — the kill switch survives every redeploy.
 */
export function reconcileAutomations(
  declared: readonly DeclaredAutomation[],
  stored: readonly AutomationRecord[],
  owner: Principal,
  authoredBy: "code" | "manifest",
): ReconcilePlan {
  const mine = new Map(
    stored
      .filter((record) => record.authoredBy === authoredBy && record.owner.subject === owner.subject)
      .map((record) => [record.id, record] as const),
  );
  const create: CreateAutomationInput[] = [];
  const declaredIds = new Set<AutomationId>();
  for (const entry of declared) {
    const when = toTriggerSource(entry.when);
    const id = declaredAutomationId(entry, when);
    declaredIds.add(id);
    const current = mine.get(id);
    if (current?.disarmedBy === "user") continue;
    if (current?.armed === true && automationHash(current) === automationHash({ ...entry, when })) continue;
    create.push({
      id,
      owner,
      when: entry.when,
      task: entry.task,
      ...(entry.agent === undefined ? {} : { agent: entry.agent }),
      ...(entry.timezone === undefined ? {} : { timezone: entry.timezone }),
      authoredBy,
    });
  }
  const disarm = [...mine.values()]
    .filter((record) => !declaredIds.has(record.id) && record.armed && record.disarmedBy === undefined)
    .map((record) => record.id);
  return { create, disarm };
}
