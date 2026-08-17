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
}

/** An app id is colon-free by its own grammar (`packages/core/src/ids.ts`), so
 *  the pair cannot shift however the subject is spelled. */
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
    const rows = await listAllEngineRecords(engine, APP_SEEN_COLLECTION, { refs: { subject } });
    const seen = new Set(rows.map((record) => record.id));
    return new Set(appIds.filter((appId) => !seen.has(rowId(appId, subject))));
  },
});
