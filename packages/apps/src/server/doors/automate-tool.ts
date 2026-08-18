/**
 * `vendo_automate` — the one door a calling agent arms an automation through.
 *
 * It creates ANY automation: one that reaches an app's functions and one that
 * reaches nothing but host tools are the same record, because an automation
 * carries no app reference at all. A task reaches an app the same way it reaches
 * anything else — by naming a granted tool in its own words.
 *
 * `vendo_make` still arms the schedule half of a COMPOUND ask ("build me the
 * board and refresh it every Monday"), through the same one create operation.
 * This is the door for a schedule with nothing to build.
 */
import {
  AUTOMATIONS_DOCS_URL,
  durationMs,
  VendoError,
  VENDO_AUTOMATION_REF_KIND,
  type AutomationRecord,
  type AutomationTask,
  type Json,
  type RunContext,
  type ToolCall,
  type ToolOutcome,
  type TriggerSource,
  type VendoAutomationPart,
  type VendoAutomationRef,
  type When,
} from "@vendoai/core";
import { Cron } from "croner";
import { input, optionalString } from "./tool-args.js";
import type { AutomationsSeam } from "../runtime/types.js";

/** WHEN it fires, in the words a person would use for it. */
export const whenSays = (when: TriggerSource): string =>
  when.kind === "schedule"
    ? `on schedule ${when.cron ?? when.every ?? when.at ?? "(unset)"}`
    : when.kind === "host-event"
      ? `on the host event "${when.event}"`
      : `on "${when.connector}" webhooks`;

/** WHAT it does, when the record can say so itself. A goal already is a
 *  sentence; a steps task is only named by the plan that authored it. */
const actionSays = (task: AutomationTask): string | undefined =>
  task.kind === "goal" ? task.prompt : undefined;

/**
 * THE producer of a `data-vendo-automation` part — one builder, so the card an
 * automation raises on its own and the one it raises alongside an app say the
 * same thing. Humanized HERE, on the way out: the card has no task to read.
 */
export const automationCard = (
  record: AutomationRecord,
  enabled: boolean,
  options: { name?: string; pendingGrants?: number } = {},
): VendoAutomationPart => {
  const action = options.name ?? actionSays(record.task);
  return {
    type: "data-vendo-automation",
    automationId: record.id,
    name: (action ?? whenSays(record.when)).slice(0, 80),
    enabled,
    when: record.when,
    ...(action === undefined ? {} : { action }),
    ...(options.pendingGrants === undefined || options.pendingGrants === 0
      ? {}
      : { pendingGrants: options.pendingGrants }),
  };
};

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
  const interval = when.every === undefined ? null : durationMs(when.every);
  return interval === null ? undefined : new Date(Date.now() + interval).toISOString();
};

/** The object half of `when`, by the key that decides which shape it is. */
const WHEN_KEYS = ["every", "at", "event", "webhook"] as const;

const WHEN_SHAPES = 'a 5-field cron string, or EXACTLY one of {"every":"1d"}, '
  + '{"at":"<ISO date-time>"}, {"event":"<name>"}, {"webhook":"<connector>"}';

/**
 * The five shapes `.on()` takes, off the wire. Core's `toTriggerSource` — which
 * the create operation runs — normalizes them and refuses a cron or an interval
 * nothing can fire; what it cannot refuse is an object that names NO shape at
 * all, because an absent `webhook` is not the empty one it rejects, so `{}`
 * falls through to `{kind:"external"}` with no connector: an automation nothing
 * can ever trigger, reported as armed. Naming exactly one shape is the check
 * that has to happen here, at the wire, and a JSON schema cannot say it.
 */
const readWhen = (value: Json | undefined): When => {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const named = WHEN_KEYS.filter((key) => key in value);
    if (named.length === 1) return value as When;
  }
  throw new VendoError(
    "validation",
    `when is ${JSON.stringify(value)} — it must be ${WHEN_SHAPES}. See ${AUTOMATIONS_DOCS_URL}`,
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
      "nothing can be scheduled here: this deployment composed no automations engine — "
      + "mount the automations block (createVendo's automations option) and ask again",
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
  // still has to allow is said HERE, in the line the model reads out, rather
  // than discovered by the first away run failing.
  //
  // THIS call rides along (07 §3): its own approval ask is where the powers this
  // automation will hold were named, so under a policy that asks about arming,
  // the yes already given mints them and there is no second per-tool ceremony.
  // Under a policy that runs arming unasked, nobody saw a powers line and the
  // engine captures each one as a pending ask exactly as before.
  const armed = await seam.enable(record.id, ctx, { armedBy: call });
  const next = nextRunAt(record.when, record.timezone ?? "UTC");
  const ref: VendoAutomationRef = {
    kind: VENDO_AUTOMATION_REF_KIND,
    automationId: record.id,
    summary: armed.missing.length === 0
      ? `${task} — ${whenSays(record.when)}`
      : `${task} — ${whenSays(record.when)}; ${armed.missing.length} permission(s) still to allow before it can run unattended`,
    armed: armed.enabled,
    ...(next === undefined ? {} : { nextRunAt: next }),
  };
  return { status: "ok", output: ref as unknown as Json };
};
