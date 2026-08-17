import {
  declaredAutomationId,
  reconcileAutomations,
  toTriggerSource,
  VendoError,
  type AppId,
  type ApprovalRequest,
  type AutomationId,
  type DeclaredAutomation,
  type RunContext,
} from "@vendoai/core";
import {
  type AppDocument,
} from "../../contract/index.js";
import { requestAppWithBootRetry } from "./box-agent.js";
import type { MachineLifecycle } from "./machine-lifecycle.js";
import { parseVendoManifest } from "./manifest.js";
import type { EngineOps } from "../persistence/engine.js";
import { APPS_COLLECTION, listAllEngineRecords, rowFromRecord } from "../persistence/persistence.js";
import type { AutomationsSeam } from "../runtime/types.js";

/**
 * There is exactly ONE scheduling system: automation records fired by the
 * automations engine. A machine app's `vendo.json` `schedules` are a
 * DECLARATION, not a scheduler — this module reads them over the box door and
 * folds each one into an ordinary automation, so a manifest fire gets what only
 * chat-authored automations used to get: a run record, the kill switch, and a
 * panel row.
 *
 * The declaration is CODE, so the fold-in is a reconcile, and it is the SAME
 * reconcile `agent.on` runs at boot — core's `reconcileAutomations`, written
 * once. A changed cron replaces its own record, a schedule dropped from the
 * manifest disarms its own, and an unchanged manifest touches nothing, so a
 * person who turned a converted automation OFF stays off.
 */

/** The stable identity a manifest schedule declares. It carries the app id
 *  because automations are deployment-wide records with no app reference of
 *  their own: two apps declaring `fn: digest` are two automations. */
const declarationName = (appId: AppId, fn: string): string => `${appId}-${fn}`;

/** One folded-in schedule, and what this sync did about arming it. */
export interface ManifestAutomationResult {
  id: AutomationId;
  cron: string;
  fn: string;
  /**
   * - `armed` — this sync created it and the engine armed it.
   * - `disarmed` — this sync created it and it is NOT armed.
   *
   * A declaration that did not change is absent entirely: this sync did not
   * touch its arm state, and whether it is currently armed is the automations
   * engine's answer to give (`automations.list`), not this converter's —
   * claiming `true` would erase a person's kill switch on paper.
   */
  arming: "armed" | "disarmed";
  /** Standing-grant asks the arming left waiting. `fn:` steps capture an empty
   *  consent surface, so this is empty unless the seam grew a surface. */
  missing: ApprovalRequest[];
}

export interface ManifestTriggerSync {
  /** The app document after the fold-in landed. */
  app: AppDocument;
  automations: ManifestAutomationResult[];
}

/** The doctor's dev-only view of one machine-bearing app (reporting only). */
export interface AppMachineStatus {
  appId: AppId;
  name: string;
  provisionedAt: string;
  awake: boolean;
  /** The automations this app names. When one last FIRED is the automation's own
   *  run history, not a field here. */
  automations: AutomationId[];
}

export interface ManifestTriggerConfig {
  engine: EngineOps;
  lifecycle: MachineLifecycle;
  /** Bounded read-mutate-CAS on the app row (the runtime's own recipe). */
  updateDocument(appId: AppId, mutate: (doc: AppDocument) => AppDocument): Promise<AppDocument>;
  /** Unset ⇒ no engine is composed, and a manifest that declares a schedule
   *  says so LOUDLY rather than storing something nothing will ever fire. */
  automations?: AutomationsSeam;
}

const decoder = new TextDecoder();

export const createManifestTriggers = (config: ManifestTriggerConfig) => {
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
     * Read the box's `vendo.json` and make its schedules real: reconcile them
     * against the automations this app already names, create what is new or
     * changed, disarm what the manifest dropped, and arm what this sync made.
     */
    async sync(app: AppDocument, ctx: RunContext): Promise<ManifestTriggerSync> {
      const declared = await declaredSchedules(app);
      const byId = new Map<AutomationId, { declaration: DeclaredAutomation; cron: string; fn: string }>();
      for (const { cron, fn } of declared) {
        const declaration: DeclaredAutomation = {
          id: declarationName(app.id, fn),
          when: cron,
          task: { kind: "steps", steps: [{ id: "fire", tool: `fn:${fn}` }] },
        };
        // The ONE converter, which is also the cron arbiter: a declaration the
        // manifest's field-shape regex admits but no calendar time satisfies
        // ("99 99 * * *") fails LOUDLY here, at the read boundary, rather than
        // silently at fire time.
        const id = declaredAutomationId(declaration, toTriggerSource(cron));
        if (byId.has(id)) {
          // Two declarations that cannot both be honored: one identity is one
          // automation, so this must be said out loud rather than last-wins.
          throw new VendoError(
            "validation",
            `invalid vendo.json: schedules for "${fn}" collapse to one automation (${id}); `
            + "give each schedule its own fn",
            { appId: app.id },
          );
        }
        byId.set(id, { declaration, cron, fn });
      }
      const seam = config.automations;
      if (seam === undefined) {
        if (declared.length === 0) return { app, automations: [] };
        throw new VendoError(
          "validation",
          `vendo.json declares ${declared.length} schedule(s) but this deployment composed no automations engine, so none of them can ever run`,
          { appId: app.id },
        );
      }
      const stored = await seam.resolve(app.automations ?? [], ctx);
      const plan = reconcileAutomations(
        [...byId.values()].map(({ declaration }) => declaration),
        stored,
        ctx.principal,
        "manifest",
      );
      const wanted = new Map(plan.create.map((input) => [input.id, input]));
      const automations: ManifestAutomationResult[] = [];
      const created: AutomationId[] = [];
      for (const [id, { cron, fn }] of byId) {
        const input = wanted.get(id);
        // Unchanged: left exactly as the person last decided it — re-arming here
        // would undo a kill switch.
        if (input === undefined) continue;
        const record = await seam.create(input, ctx);
        created.push(record.id);
        // `fn:` steps capture an EMPTY consent surface (they run in the app's
        // own box, under the app's own boundary), so arming completes here
        // rather than parking a card — unchanged law, stated by the seam.
        const armed = await seam.enable(record.id, ctx);
        automations.push({
          id: record.id,
          cron,
          fn,
          arming: armed.enabled ? "armed" : "disarmed",
          missing: armed.missing,
        });
      }
      for (const id of plan.disarm) await seam.disable(id, ctx);
      const disarmed = new Set(plan.disarm);
      const next = await config.updateDocument(app.id, (doc) => ({
        ...doc,
        automations: [...new Set([
          // Everything the manifest does not own keeps its place: a
          // chat-authored automation is never in `disarm`, because the reconcile
          // only ever sees the manifest-authored half.
          ...(doc.automations ?? []).filter((id) => !disarmed.has(id)),
          ...created,
        ])],
      }));
      return { app: next, automations };
    },

    /** Dev-only doctor reporting: machine-bearing apps and what they automate. */
    async report(): Promise<AppMachineStatus[]> {
      const statuses: AppMachineStatus[] = [];
      for (const record of await listAllEngineRecords(config.engine, APPS_COLLECTION, {})) {
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
          automations: [...row.doc.automations ?? []],
        });
      }
      return statuses;
    },
  };
};
