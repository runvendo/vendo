/**
 * `agent.on(...)` — automations authored in code.
 *
 * A DECLARATION, never a write: the call validates and stashes, and the
 * umbrella's boot reconcile is what reaches the store. That split is the layer
 * map, not a preference — this package may not import `@vendoai/automations`
 * (`scripts/dependency-guard.mjs`), so the declaration stops here and
 * `createVendo` carries it the rest of the way.
 *
 * Consent for a code-authored automation IS the code, so a redeploy reconciles:
 * new → created, edited → a new identity with the old one disarmed, deleted from
 * the source → disarmed (never deleted, so its run history survives).
 */
import {
  AUTOMATIONS_DOCS_URL,
  reconcileAutomations,
  toTriggerSource,
  VendoError,
  type AutomationRecord,
  type Budget,
  type DeclaredAutomation,
  type Principal,
  type ReconcilePlan,
  type When,
} from "@vendoai/core";
import type { VendoAgent } from "./agent.js";

export interface OnOptions {
  /** Stable identity. Unset → hash(when + task + agent), so editing the cron or
   *  the words MINTS A NEW automation and disarms the old one at the next boot.
   *  Name one to keep an automation's identity across an edit. */
  id?: string;
  /** The zone `when` is read in; unset → UTC. */
  timezone?: string;
  budget?: Budget;
}

const declarations = new WeakMap<VendoAgent, DeclaredAutomation[]>();

/** What `.on()` collected, read the way {@link agentComposition} is — through a
 *  WeakMap, so the public agent object stays exactly what it was. */
export const agentAutomations = (agent: VendoAgent): readonly DeclaredAutomation[] =>
  declarations.get(agent) ?? [];

/** The body of {@link VendoAgent.on}, bound to the agent whose `name` every
 *  declaration carries — that name is the runner-map key the firing looks up. */
export function declareAutomation(
  agent: VendoAgent,
  when: When,
  task: string,
  options: OnOptions = {},
): void {
  // Synchronously, at declaration — a bad cron is a boot error with a way out,
  // never a firing that quietly never happens. `toTriggerSource` is core's one
  // converter, shared by all four authoring doors, so they cannot drift.
  toTriggerSource(when);
  if (task.trim() === "") {
    throw new VendoError(
      "validation",
      `${agent.name}.on() was given an empty task — an automation runs on the words you write there, e.g. `
      + `${agent.name}.on("0 9 * * 1", "summarize the week and email ops"). See ${AUTOMATIONS_DOCS_URL}`,
    );
  }
  declarations.set(agent, [...agentAutomations(agent), {
    ...(options.id === undefined ? {} : { id: options.id }),
    when,
    task: {
      kind: "goal",
      prompt: task,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    },
    agent: agent.name,
    ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
  }]);
}

/**
 * What the umbrella applies at boot: every declared automation across the
 * agents it composed, diffed against what is stored, through core's one
 * reconcile.
 *
 * Names ride through VERBATIM. Two agents called "support" produce two sets of
 * declarations both claiming that runner name; collapsing them here would hide
 * a collision the runner map has to throw on.
 */
export const agentAutomationPlan = (
  agents: readonly VendoAgent[],
  stored: readonly AutomationRecord[],
  owner: Principal,
): ReconcilePlan =>
  reconcileAutomations(agents.flatMap((agent) => agentAutomations(agent)), stored, owner, "code");
