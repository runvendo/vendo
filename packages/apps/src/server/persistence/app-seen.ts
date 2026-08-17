/**
 * Per-(app, person) READ STATE — has this person laid eyes on this app yet.
 *
 * One row per pair, written the first time the app renders for them and never
 * rewritten: `insertIfAbsent` IS the idempotence, so a mark costs one write on
 * the first render and one refused write after that, with no read in front of
 * it. `seenAt` is therefore first-seen, not last-seen — the arrival dot asks
 * "has this ever been looked at", which a later view cannot un-answer.
 *
 * The rows live in the GENERIC records collection, like the placement and slot
 * rows beside them: `vendo_app_seen` is neither reserved nor dedicated
 * (`packages/store/src/routing.ts`), so it routes to `vendo_records` on every
 * adapter with no migration to run.
 *
 * `refs` carries `subject` — the key the erase cascade matches
 * (`vendo_records WHERE refs @> '{"subject": …}'::jsonb`, `packages/store/src/
 * erase.ts`), and the only query this surface makes — plus `app_id`, the same
 * ref name the rest of this package sweeps an app by.
 */
import type { AppId, IsoDateTime } from "@vendoai/core";
import type { EngineOps } from "./engine.js";
import { listAllEngineRecords } from "./persistence.js";

/** The generic collection the seen rows live in (never a dedicated table). */
export const APP_SEEN_COLLECTION = "vendo_app_seen";

/** What one row holds. */
export interface AppSeenRow {
  seenAt: IsoDateTime;
}

export interface AppSeenStore {
  /** Idempotent: the first render wins and every later one costs one refusal. */
  mark(appId: AppId, subject: string): Promise<void>;
  /** Which of `appIds` this person has never had rendered to them. */
  unseen(appIds: readonly AppId[], subject: string): Promise<ReadonlySet<AppId>>;
  /** Drop every person's read state for one app (app-deletion cleanup). */
  clearForApp(appId: AppId): Promise<void>;
}

/** `appIdSchema` pins only the `app_` PREFIX (`packages/core/src/ids.ts:39`), so
 *  the type does not forbid a colon and this pair is not unambiguous by grammar.
 *  It is unambiguous by the MINT: every app id Vendo writes is `app_` + a uuid
 *  (`doors/build-surface.ts`, `apps-surface.ts` fork), which carries no colon.
 *  Nothing parses this id — both halves are known at every call — so the pair
 *  only has to be unique, and it is. */
const rowId = (appId: AppId, subject: string): string => `${appId}:${subject}`;

export const appSeenStore = (engine: EngineOps): AppSeenStore => ({
  async mark(appId, subject) {
    const row: AppSeenRow = { seenAt: new Date().toISOString() };
    await engine.insertIfAbsent(APP_SEEN_COLLECTION, {
      id: rowId(appId, subject),
      data: row,
      refs: { subject, app_id: appId },
    });
  },

  async unseen(appIds, subject) {
    // Point reads for the page in hand, never a scan of this person's history:
    // the row set grows with every app they have ever opened, and the answer
    // only ever concerns the ids being listed.
    const rows = await Promise.all(
      appIds.map((appId) => engine.get(APP_SEEN_COLLECTION, rowId(appId, subject))),
    );
    return new Set(appIds.filter((_appId, index) => rows[index] === null));
  },

  async clearForApp(appId) {
    // Swept by APP, not by one subject: a shared app was seen by people the
    // deleter cannot enumerate (the same argument placements.ts makes).
    for (const record of await listAllEngineRecords(engine, APP_SEEN_COLLECTION, { refs: { app_id: appId } })) {
      await engine.delete(APP_SEEN_COLLECTION, record.id);
    }
  },
});
