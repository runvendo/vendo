import { z } from "zod";
import { isoDateTimeSchema, runIdSchema, type IsoDateTime, type RunId } from "./ids.js";

/** 01-core §11 */
export type TriggerSource =
  | { kind: "schedule"; cron?: string; every?: string; at?: IsoDateTime }
  | { kind: "host-event"; event: string }
  | { kind: "external"; connector: string; event?: string; config?: unknown };

/** 01-core §3. Lives beside TriggerSource (not in run-context.ts) so grants,
 *  audit, AND run-context can all import it without a runtime module cycle. */
export interface TriggerRef {
  runId: RunId;
  kind: TriggerSource["kind"];
  /**
   * WHICH automation is firing. An automation is a record consented to on its
   * own, so this — not an app id — is what the guard matches an away grant on
   * (`PermissionGrant.automationId`). Absent on a run that is nobody's
   * automation, which then holds no away authority at all.
   */
  automationId?: string;
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
  automationId: z.string().optional(),
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
    event: z.string().optional(),
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
