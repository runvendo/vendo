import { z } from "zod";
import { isoDateTimeSchema, runIdSchema, type IsoDateTime, type RunId } from "./ids.js";
import { openEnum, openKindVariant } from "./open-enum.js";

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
}

/** 01-core §3 */
export const triggerRefSchema = z.object({
  runId: runIdSchema,
  // CORE-11: trigger kinds are §15-additive — a future kind must not brick refs.
  kind: openEnum<TriggerSource["kind"]>(["schedule", "host-event", "external"]),
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
  // CORE-11 — §15: unknown trigger kinds are additive; known kinds stay strict.
).or(openKindVariant(["schedule", "host-event", "external"])) satisfies z.ZodType<TriggerSource>;

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
  | { kind: "agentic"; prompt: string; budget?: { maxToolCalls?: number } }
  | { kind: "steps"; steps: Step[] };

/** 01-core §11 */
export const runModelSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agentic"),
    prompt: z.string(),
    budget: z.object({ maxToolCalls: z.number().optional() }).passthrough().optional(),
  }).passthrough(),
  z.object({
    kind: z.literal("steps"),
    steps: z.array(stepSchema),
  }).passthrough(),
  // CORE-11 — §15: run models are additive; known kinds stay strict.
]).or(openKindVariant(["agentic", "steps"])) satisfies z.ZodType<RunModel>;

/** 01-core §11 */
export interface Trigger {
  on: TriggerSource;
  run: RunModel;
}

/** 01-core §11 */
export const triggerSchema = z.object({
  on: triggerSourceSchema,
  run: runModelSchema,
}).passthrough() satisfies z.ZodType<Trigger>;
