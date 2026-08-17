/**
 * `vendo_automate` — the one door a calling agent arms an automation through.
 *
 * It creates ANY automation: one that reaches an app's functions and one that
 * reaches nothing but host tools are the same record, because an automation
 * carries no app reference at all. A task reaches an app the same way it reaches
 * anything else — by naming a granted tool in its own words.
 *
 * `vendo_make` still arms the schedule half of a compound ask ("build me the
 * board AND run it every Monday"), through the same one create operation. This
 * is the door for a schedule with no app to build.
 */
import {
  VendoError,
  VENDO_AUTOMATION_REF_KIND,
  type Json,
  type RunContext,
  type ToolCall,
  type ToolOutcome,
  type TriggerSource,
  type VendoAutomationRef,
  type When,
} from "@vendoai/core";
import { Cron } from "croner";
import { input, optionalString } from "./tool-args.js";
import type { AutomationsSeam } from "../runtime/types.js";

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * WHEN it next fires, computed from `when` on the way out — never a stored
 * column, so it cannot go stale and nothing has to keep it fresh. Absent for an
 * event or webhook record, which has no next run to name.
 */
const nextRunAt = (when: TriggerSource, timezone: string): string | undefined => {
  if (when.kind !== "schedule") return undefined;
  if (when.at !== undefined) return when.at;
  if (when.cron !== undefined) {
    return new Cron(when.cron, { timezone, paused: true }).nextRun()?.toISOString();
  }
  const every = /^(\d+)([smhd])$/.exec(when.every ?? "");
  return every === null
    ? undefined
    : new Date(Date.now() + Number(every[1]) * (UNITS[every[2] as string] as number)).toISOString();
};

/** The one line the model says out loud and the embed's chrome renders. */
const summarize = (when: TriggerSource, task: string): string => {
  const fires = when.kind === "schedule"
    ? `on schedule ${when.cron ?? when.every ?? when.at ?? "(unset)"}`
    : when.kind === "host-event"
      ? `on the host event "${when.event}"`
      : `on "${when.connector}" webhooks`;
  return `${task} — ${fires}`;
};

/** The five shapes `.on()` takes, off the wire. Core's `toTriggerSource` is what
 *  normalizes and refuses one; this only rejects a slot that is neither a cron
 *  string nor an object, which the JSON schema alone cannot say. */
const readWhen = (value: Json | undefined): When => {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as When;
  throw new VendoError(
    "validation",
    'when must be a 5-field cron string, or one of {"every":"1d"}, {"at":"<ISO date-time>"}, {"event":"<name>"}, {"webhook":"<connector>"}',
  );
};

export const runAutomateTool = async (
  seam: AutomationsSeam | undefined,
  call: ToolCall,
  ctx: RunContext,
): Promise<ToolOutcome> => {
  const args = input(call.args, ["task"], ["when", "agent", "timezone"]);
  const when = readWhen(args.when);
  const task = args.task as string;
  const agent = optionalString(args.agent, "agent");
  const timezone = optionalString(args.timezone, "timezone");
  if (seam === undefined) {
    throw new VendoError(
      "not-implemented",
      "nothing can be scheduled here: this deployment composed no automations engine",
    );
  }
  const record = await seam.create({
    owner: ctx.principal,
    when,
    task: { kind: "goal", prompt: task },
    ...(agent === undefined ? {} : { agent }),
    ...(timezone === undefined ? {} : { timezone }),
    authoredBy: "chat",
  }, ctx);
  // Grant capture, the same flow every other authoring door runs: what the owner
  // still has to allow is said HERE, in the sentence the model reads out, rather
  // than discovered by the first away run failing.
  const armed = await seam.enable(record.id, ctx);
  const next = nextRunAt(record.when, record.timezone ?? "UTC");
  const ref: VendoAutomationRef = {
    kind: VENDO_AUTOMATION_REF_KIND,
    automationId: record.id,
    summary: armed.missing.length === 0
      ? summarize(record.when, task)
      : `${summarize(record.when, task)} — ${armed.missing.length} permission(s) still to allow before it can run unattended`,
    armed: armed.enabled,
    ...(next === undefined ? {} : { nextRunAt: next }),
  };
  return { status: "ok", output: ref as unknown as Json };
};
