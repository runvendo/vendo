/**
 * Which TRIGGERS of an app are armed — the per-trigger arm a person turns on and
 * off, read alongside the app-level `enabled` the apps runtime owns.
 *
 * Lifted out of `createAutomationsEngine` unchanged.
 */
import { type Trigger, type VendoRecord } from "@vendoai/core";
import type { AutomationsEngineContext } from "./engine-context.js";
import { allRecords } from "./rows.js";
import { triggerKey, triggersOf } from "./sponsorship.js";
import { ARMED, type AppRow } from "./types.js";

export type ArmedDeps = Pick<AutomationsEngineContext, "config" | "writeApp">;

export type ArmedAccess = Pick<
  AutomationsEngineContext,
  "setArmed" | "armedTriggers" | "armedFor" | "isArmed" | "disarmTrigger"
>;

export const createArmed = ({ config, writeApp }: ArmedDeps): ArmedAccess => {
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
   * without anyone having armed it.
   */
  const armedTriggers = (row: AppRow, armed: ReadonlySet<string>): Trigger[] =>
    row.enabled
      ? triggersOf(row.doc).filter((trigger) => armed.has(triggerKey(row.doc.id, trigger.id)))
      : [];

  /** The armed set for these app rows. */
  const armedFor = async (rows: readonly AppRow[]): Promise<Set<string>> => {
    // ONE query for every (app, trigger) key, so per-trigger arming is not an
    // N+1 get on the tick's path.
    const keys = rows.flatMap(
      (row) => triggersOf(row.doc).map((trigger) => triggerKey(row.doc.id, trigger.id)),
    );
    return new Set<string>(keys.length === 0
      ? []
      : (await allRecords(config.store.records(ARMED), { ids: keys })).map((record) => record.id));
  };

  /** The same question for one trigger, for the paths that hold a single app. */
  const isArmed = async (row: AppRow, triggerId: string): Promise<boolean> =>
    armedTriggers(row, await armedFor([row])).some((trigger) => trigger.id === triggerId);

  /** Turn ONE trigger off, leaving the app's others exactly as they were.
   *
   *  The remaining triggers are written out as explicit armed rows first, so a
   *  disarm can never take a sibling with it. `enabled` then follows: false
   *  exactly when nothing is left. */
  const disarmTrigger = async (record: VendoRecord, row: AppRow, triggerId: string): Promise<void> => {
    const remaining = armedTriggers(row, await armedFor([row]))
      .filter((trigger) => trigger.id !== triggerId);
    for (const trigger of remaining) await setArmed(row.doc.id, trigger.id, true);
    await setArmed(row.doc.id, triggerId, false);
    row.enabled = remaining.length > 0;
    await writeApp(record, row);
  };

  return { setArmed, armedTriggers, armedFor, isArmed, disarmTrigger };
};
