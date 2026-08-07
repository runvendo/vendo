import { z } from "zod";
import { isoDateTimeSchema, runIdSchema, type IsoDateTime, type RunId } from "./ids.js";

/** 01-core §11 */
export type TriggerSource =
  | { kind: "schedule"; cron?: string; every?: string; at?: IsoDateTime }
  | { kind: "host-event"; event: string }
  | { kind: "external"; connector: string; event: string; config?: unknown };

/** 01-core §3. Lives beside TriggerSource (not in run-context.ts) so grants,
 *  audit, AND run-context can all import it without a runtime module cycle. */
export interface TriggerRef {
  runId: RunId;
  kind: TriggerSource["kind"];
  /**
   * WHICH trigger of the app is firing — its id within the app's trigger list.
   *
   * An automation is an app with a LIST of triggers, each consented to on its
   * own, so the app id alone cannot say what authority a fire-time call holds:
   * `RunContext.appId` plus this is the pair the guard matches an away grant on.
   * Optional because the ref is also read off persisted audit rows written
   * before triggers were a list; a fire-time call that carries none is read as
   * {@link DEFAULT_TRIGGER_ID}, the same name read normalization gives a
   * pre-list document's one trigger.
   */
  id?: string;
  /**
   * The FIRING this run belongs to, as opposed to the run itself: the id of the
   * first run of it. A re-run inherits it; a run that is nobody's re-run has its
   * own id here or nothing at all.
   *
   * It exists because the effect ledger (Build contract §7) has to answer "has
   * this effect already happened", and the honest unit of that question is the
   * firing, not the run. "Fail loudly, then run it again" mints a FRESH run of
   * the same trigger on the same event, so keying receipts on `runId` meant the
   * re-run missed every receipt the failed run wrote and repeated work that had
   * already landed.
   *
   * Deliberately NOT `runId` itself: a `task`-duration grant and every audit row
   * key off `runId`, and both must keep meaning THIS run — one run's task grant
   * may not authorize its re-run, and the trail may not claim one run did
   * another's work.
   */
  lineageId?: RunId;
}

/** 01-core §3 */
export const triggerRefSchema = z.object({
  runId: runIdSchema,
  kind: z.enum(["schedule", "host-event", "external"]),
  id: z.string().optional(),
  lineageId: runIdSchema.optional(),
}).passthrough() satisfies z.ZodType<TriggerRef>;

/** 01-core §11 */
export const triggerSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("schedule"),
    cron: z.string().optional(),
    every: z.string().optional(),
    at: isoDateTimeSchema.optional(),
  }).passthrough(),
  z.object({
    kind: z.literal("host-event"),
    event: z.string(),
  }).passthrough(),
  z.object({
    kind: z.literal("external"),
    connector: z.string(),
    event: z.string(),
    config: z.unknown().optional(),
  }).passthrough(),
]).refine(
  (source) => source.kind !== "schedule"
    || [source.cron, source.every, source.at].filter((value) => value !== undefined).length === 1,
  { message: "schedule must specify exactly one of cron, every, or at" },
) satisfies z.ZodType<TriggerSource>;

/** 01-core §11 */
export interface Step {
  id: string;
  tool: string;
  args?: Record<string, string>;
  if?: string;
  forEach?: string;
}

/** 01-core §11 */
export const stepSchema = z.object({
  id: z.string(),
  tool: z.string(),
  args: z.record(z.string()).optional(),
  if: z.string().optional(),
  forEach: z.string().optional(),
}).passthrough() satisfies z.ZodType<Step>;

/** 01-core §11 */
export type RunModel =
  | {
    kind: "agentic";
    prompt: string;
    budget?: { maxToolCalls?: number };
    /**
     * What this run is EXPECTED to reach — tool names and/or service-action
     * slugs — authored alongside the automation.
     *
     * Best-effort by nature: a judgment call cannot promise its own tool list
     * the way steps do, so this is a declaration of intent, never an authority
     * boundary. It is what the owner is asked to allow at arm time; the guard
     * still decides every call, and a call outside the declaration parks like
     * any ungranted away call. Absent, arm-time capture falls back to proposing
     * every bound descriptor, as it always has.
     */
    tools?: string[];
  }
  | { kind: "steps"; steps: Step[] };

/** 01-core §11 */
export const runModelSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agentic"),
    prompt: z.string(),
    budget: z.object({ maxToolCalls: z.number().optional() }).passthrough().optional(),
    tools: z.array(z.string()).optional(),
  }).passthrough(),
  z.object({
    kind: z.literal("steps"),
    steps: z.array(stepSchema),
  }).passthrough(),
]) satisfies z.ZodType<RunModel>;

/** A trigger's own name inside its app's list. A bare identifier, the same
 *  grammar step ids use, because it is written by hand in `vendo.json` and read
 *  back in URLs, wire payloads and store refs — anything wider would need
 *  escaping at every one of those doors. */
export const TRIGGER_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 01-core §11 — one trigger of an app's LIST. `id` names it within that list
 *  (unique there), because everything keyed to a trigger — grants, sponsorship,
 *  schedule cursors, webhook secrets, runs — is keyed to (app, trigger) and an
 *  app with two triggers must not have them share any of it. */
export interface Trigger {
  id: string;
  on: TriggerSource;
  run: RunModel;
}

/** 01-core §11 */
export const triggerSchema = z.object({
  id: z.string().regex(TRIGGER_ID_PATTERN, "trigger id must match /^[A-Za-z_][A-Za-z0-9_]*$/"),
  on: triggerSourceSchema,
  run: runModelSchema,
}).passthrough() satisfies z.ZodType<Trigger>;

/** The id a legacy single-`trigger` document's one trigger takes on read.
 *  Written down once because both the read normalization and every writer that
 *  produces a one-trigger app must agree on it. */
export const DEFAULT_TRIGGER_ID = "main";

/**
 * The app-row ref key that says "this app has a trigger of this kind".
 *
 * An app has a LIST of triggers, so "which kind does this app fire on" is a SET,
 * not a value — and a ref is matched by equality. One key PER KIND is what keeps
 * the automations tick and `vendo.emit` ref-filtered (never a scan) now that an
 * app may carry a schedule trigger and a host-event trigger at once.
 *
 * Written down here because three places have to agree byte for byte: the store's
 * generated columns, the conformance memory store's derived refs, and the
 * engine's queries. `-` is not valid in an identifier-ish key, hence the `_`.
 */
export const triggerKindRefKey = (kind: TriggerSource["kind"]): string =>
  `trigger_kind_${kind.replace(/-/g, "_")}`;

/** Every kind key, in the frozen order of {@link TriggerSource}. The set is
 *  closed, which is what makes one key per kind a bounded design. */
export const TRIGGER_KIND_REF_KEYS: readonly string[] =
  (["schedule", "host-event", "external"] as const).map(triggerKindRefKey);

/** The ref value: presence only, so a row either carries the key or does not.
 *  The store's generated columns project NULL for absent, which never matches. */
export const TRIGGER_KIND_REF_PRESENT = "1";

/** The kind refs an app row carries, derived from its trigger list. */
export const triggerKindRefs = (
  triggers: readonly Pick<Trigger, "on">[] | undefined,
): Record<string, string> => Object.fromEntries(
  [...new Set((triggers ?? []).map((trigger) => triggerKindRefKey(trigger.on.kind)))]
    .map((key) => [key, TRIGGER_KIND_REF_PRESENT]),
);
