import {
  VendoError,
  type AppId,
  type ApprovalRequest,
  type RunContext,
  type StoreAdapter,
  type Trigger,
} from "@vendoai/core";
import {
  type AppDocument,
} from "../../contract/index.js";
import { Cron } from "croner";
import { requestAppWithBootRetry } from "./box-agent.js";
import type { MachineLifecycle } from "./machine-lifecycle.js";
import { parseVendoManifest } from "./manifest.js";
import { listAllRecords, rowFromRecord } from "../persistence/persistence.js";

/**
 * There is exactly ONE scheduling system: doc triggers fired by the automations
 * engine. A machine app's `vendo.json` `schedules` are a DECLARATION, not a
 * scheduler — this module reads them over the box door and converts each one
 * into an ordinary doc trigger, so a manifest fire gets what only doc triggers
 * used to get: a run record, a trigger id, the kill switch, and a panel row.
 */

/**
 * Converter-owned triggers carry this id prefix, and NOTHING else in the app's
 * trigger list is ever read, rewritten or removed by a sync. It is a prefix
 * rather than a marker field on the trigger because the trigger list is
 * MODEL-WRITTEN: a generated document can forge any field it can see (the same
 * reason `egressApproved` is pinned from the stored row), whereas an id is
 * already the list's unique key and is validated against
 * `TRIGGER_ID_PATTERN` on every write.
 *
 * The accepted consequence: a person who hand-authors a trigger id starting
 * with `manifest_` has volunteered it to the converter.
 */
const MANIFEST_TRIGGER_PREFIX = "manifest_";

/** The trigger id a manifest `fn` converts to. `fn` admits `-` (it names a
 *  `POST /fn/<name>` route); a trigger id does not, so dashes fold to `_`. */
const manifestTriggerId = (fn: string): string =>
  `${MANIFEST_TRIGGER_PREFIX}${fn.replace(/-/g, "_")}`;

const isManifestTrigger = (trigger: Trigger): boolean =>
  trigger.id.startsWith(MANIFEST_TRIGGER_PREFIX);

/** One converted schedule, and what this sync did about arming it. */
export interface ManifestTriggerResult {
  id: string;
  cron: string;
  fn: string;
  /**
   * - `armed` — this sync armed it through the seam and the seam said yes.
   * - `disarmed` — this sync tried and it is NOT armed (no seam composed, or the
   *   seam left it off).
   * - `unchanged` — its declaration did not change, so this sync did not touch
   *   its arm state and does not report one. Whether it is currently armed is
   *   the automations engine's answer to give (`automations.list`), not this
   *   converter's: the armed row is not readable from here, and guessing `true`
   *   would erase a person's kill switch on paper.
   */
  arming: "armed" | "disarmed" | "unchanged";
  /** Standing-grant asks the arming left waiting. `fn:` steps capture an empty
   *  consent surface, so this is empty unless the seam grew a surface. */
  missing: ApprovalRequest[];
}

export interface ManifestTriggerSync {
  /** The app document after the conversion landed. */
  app: AppDocument;
  triggers: ManifestTriggerResult[];
}

/** The doctor's dev-only view of one machine-bearing app (reporting only). */
export interface AppMachineStatus {
  appId: AppId;
  name: string;
  provisionedAt: string;
  awake: boolean;
  /** The app's converted manifest schedules. When a schedule last FIRED is the
   *  automation's run history now, not a field here. */
  schedules: Array<{ cron: string; fn: string }>;
}

export interface ManifestTriggerConfig {
  store: StoreAdapter;
  lifecycle: MachineLifecycle;
  /** Bounded read-mutate-CAS on the app row (the runtime's own recipe). */
  updateDocument(appId: AppId, mutate: (doc: AppDocument) => AppDocument): Promise<AppDocument>;
  /** The arming seam (`automations.enable`). Unset ⇒ converted triggers are
   *  stored disarmed, and saying otherwise would be a lie. */
  armAutomation?(
    appId: AppId,
    triggerId: string,
    ctx: RunContext,
  ): Promise<{ enabled: boolean; missing: ApprovalRequest[] }>;
}

const decoder = new TextDecoder();

/** Croner is the cron arbiter: a declaration the manifest's field-shape regex
 *  admits but no calendar time satisfies ("99 99 * * *") must fail LOUDLY at
 *  the read boundary, not silently at fire time. */
const assertCronValid = (cron: string, appId: AppId): void => {
  try {
    // paused: constructed for validation only, never scheduled.
    new Cron(cron, { timezone: "UTC", paused: true });
  } catch (error) {
    throw new VendoError(
      "validation",
      `invalid vendo.json: schedule cron "${cron}" is not a valid cron expression: ${error instanceof Error ? error.message : "invalid"}`,
      { appId },
    );
  }
};

const triggerFor = (cron: string, fn: string): Trigger => ({
  id: manifestTriggerId(fn),
  on: { kind: "schedule", cron },
  run: { kind: "steps", steps: [{ id: "fire", tool: `fn:${fn}` }] },
});

/** The manifest's fn name, recovered from a converted trigger's one step. */
const declaredFn = (trigger: Trigger): string | undefined => {
  if (trigger.run.kind !== "steps") return undefined;
  const tool = trigger.run.steps[0]?.tool;
  return tool === undefined || !tool.startsWith("fn:") ? undefined : tool.slice("fn:".length);
};

export const createManifestTriggers = (config: ManifestTriggerConfig) => {
  const apps = config.store.records("vendo_apps");

  /** The box's declared schedules. A 404 is a valid box that declares none. */
  const declaredSchedules = async (app: AppDocument): Promise<Array<{ cron: string; fn: string }>> => {
    const machine = await config.lifecycle.wake(app);
    // A wake may resume a snapshot whose app is still booting; retry the
    // manifest read past the provider's transient "port not open".
    const answer = await requestAppWithBootRetry(machine, { method: "GET", path: "/vendo.json" }, {});
    if (answer.status === 404) return [];
    if (answer.status < 200 || answer.status >= 300) {
      throw new VendoError("validation", `vendo.json read failed (${answer.status})`, { appId: app.id });
    }
    return parseVendoManifest(decoder.decode(answer.body)).schedules ?? [];
  };

  return {
    /**
     * Read the box's `vendo.json` and make its schedules real: convert each to a
     * doc trigger, upsert by trigger id (a changed cron updates, a schedule
     * dropped from the manifest removes ITS trigger), and arm what changed.
     * Idempotent: an unchanged manifest rewrites the same triggers and re-arms
     * nothing, so a person who turned a converted trigger OFF stays off.
     */
    async sync(app: AppDocument, ctx: RunContext): Promise<ManifestTriggerSync> {
      const declared = await declaredSchedules(app);
      for (const { cron } of declared) assertCronValid(cron, app.id);
      const converted = new Map<string, { trigger: Trigger; cron: string; fn: string }>();
      for (const { cron, fn } of declared) {
        const trigger = triggerFor(cron, fn);
        if (converted.has(trigger.id)) {
          // Two declarations that cannot both be honored: one trigger id is one
          // automation, so this must be said out loud rather than last-wins.
          throw new VendoError(
            "validation",
            `invalid vendo.json: schedules for "${fn}" collapse to one trigger id (${trigger.id}); `
            + "give each schedule its own fn",
            { appId: app.id },
          );
        }
        converted.set(trigger.id, { trigger, cron, fn });
      }

      const before = new Map((app.triggers ?? []).filter(isManifestTrigger).map((trigger) => [trigger.id, JSON.stringify(trigger)]));
      const next = await config.updateDocument(app.id, (doc) => ({
        ...doc,
        // Everything NOT converter-owned keeps its place and its shape.
        triggers: [
          ...(doc.triggers ?? []).filter((trigger) => !isManifestTrigger(trigger)),
          ...[...converted.values()].map(({ trigger }) => trigger),
        ],
      }));

      const results: ManifestTriggerResult[] = [];
      for (const { trigger, cron, fn } of converted.values()) {
        // A trigger whose declaration did not change is left exactly as the
        // person last decided it: re-arming here would undo a kill switch.
        if (before.get(trigger.id) === JSON.stringify(trigger)) {
          results.push({ id: trigger.id, cron, fn, arming: "unchanged", missing: [] });
          continue;
        }
        if (config.armAutomation === undefined) {
          results.push({ id: trigger.id, cron, fn, arming: "disarmed", missing: [] });
          continue;
        }
        // `fn:` steps capture an EMPTY consent surface (they run in the app's
        // own box, under the app's own boundary), so arming completes here
        // rather than parking a card — unchanged law, stated by the seam.
        const armed = await config.armAutomation(app.id, trigger.id, ctx);
        results.push({
          id: trigger.id,
          cron,
          fn,
          arming: armed.enabled ? "armed" : "disarmed",
          missing: armed.missing,
        });
      }
      return { app: next, triggers: results };
    },

    /** Dev-only doctor reporting: machine-bearing apps and what they schedule. */
    async report(): Promise<AppMachineStatus[]> {
      const statuses: AppMachineStatus[] = [];
      for (const record of await listAllRecords(apps, {})) {
        let row;
        try {
          row = rowFromRecord(record);
        } catch {
          continue; // A corrupt row cannot schedule, and must not break reporting.
        }
        if (row.doc.machine === undefined) continue;
        statuses.push({
          appId: row.doc.id,
          name: row.doc.name,
          provisionedAt: row.doc.machine.provisionedAt,
          awake: config.lifecycle.peek(row.doc.id) !== undefined,
          schedules: (row.doc.triggers ?? [])
            .filter(isManifestTrigger)
            .flatMap((trigger) => {
              const fn = declaredFn(trigger);
              const cron = trigger.on.kind === "schedule" ? trigger.on.cron : undefined;
              return fn === undefined || cron === undefined ? [] : [{ cron, fn }];
            }),
        });
      }
      return statuses;
    },
  };
};
