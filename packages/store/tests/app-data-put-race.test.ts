import type { RecordInput } from "@vendoai/core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDataRows } from "../src/app-data-rows.js";
import { createDb, type Db, type Query } from "../src/db.js";
import { createStore, type VendoStore } from "../src/index.js";

/**
 * The absent-row race on `appData.put`.
 *
 * `put` used to read then write: `insertIfAbsent`, then `SELECT … FOR UPDATE`,
 * then an UNCONDITIONAL upsert. `FOR UPDATE` locks nothing when it returns no
 * row, so a holder who deleted the id after the insert lost and before the
 * select ran left the composer looking at an absent row — and the upsert then
 * overwrote and re-stamped whichever owner had taken the id in the meantime,
 * destroying data that owner could still neither read nor delete.
 *
 * PGlite cannot show this: it is single-connection and serializes
 * transactions, so the interleave is unreachable there. Real Postgres only,
 * which CI's store shards already set POSTGRES_URL for.
 *
 * The overlap is FORCED, not raced. The composer's own `Db` handle is paced,
 * so a scripted holder churn runs on a SECOND real connection at each of the
 * composer's statement boundaries: a fresh owner takes the id, deletes it, and
 * another fresh owner takes it. Every step is a committed write from that
 * other connection — nothing here is stubbed, and the assertion names no
 * statement, only the invariant: a put that loses the id must refuse, and the
 * owner who holds it must find their row exactly as they left it.
 */
const url = process.env["POSTGRES_URL"];
if (!url) console.info("POSTGRES_URL not set — postgres leg skipped");

const APP_ID = "app_put_race";
const COLLECTION = "notes";
const SCOPE = `app:${APP_ID}:${COLLECTION}`;
const ID = "contested";

/** The owners the churn hands the id to, and the data each one wrote. */
const CHURN = { own_first: { who: "first" }, own_last: { who: "last" } };

describe.runIf(url)("appData.put under a concurrent holder churn", () => {
  let store: VendoStore;
  let db: Db;
  let churn: Client;

  beforeAll(async () => {
    store = createStore({ url });
    await store.ensureSchema();
    db = createDb({ url: url! });
    churn = new Client({ connectionString: url });
    await churn.connect();
  });

  afterAll(async () => {
    if (churn) {
      await churn.query("DELETE FROM vendo_records WHERE collection = $1", [SCOPE]);
      await churn.query("DELETE FROM vendo_apps WHERE id = $1", [APP_ID]);
      await churn.end();
    }
    if (db) await db.close();
    if (store) await store.close();
  });

  /** One committed statement on the churn's own connection. */
  const takeId = async (owner: keyof typeof CHURN): Promise<void> => {
    await churn.query(
      `INSERT INTO vendo_records (collection, id, data, refs, created_at, updated_at, revision)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, now(), now(), 1)`,
      [SCOPE, ID, JSON.stringify(CHURN[owner]), JSON.stringify({ subject: owner })],
    );
  };
  const dropId = async (): Promise<void> => {
    await churn.query("DELETE FROM vendo_records WHERE collection = $1 AND id = $2", [SCOPE, ID]);
  };

  it("refuses, and leaves the owner who holds the id untouched", async () => {
    await churn.query(
      `INSERT INTO vendo_apps (id, subject, enabled, doc, created_at, updated_at)
       VALUES ($1, $2, true, $3::jsonb, now(), now()) ON CONFLICT (id) DO NOTHING`,
      [APP_ID, "user_1", JSON.stringify({ format: "vendo/app@1", id: APP_ID, name: APP_ID })],
    );
    await dropId();

    // The churn script, one step per statement the composer aims at
    // vendo_records: held by a foreigner, then gone, then held by another. The
    // middle step is the one a read-then-write composer walks into.
    const script = [() => takeId("own_first"), dropId, () => takeId("own_last")];
    let step = 0;
    const paced = (query: Query): Query => async (text, params) => {
      if (text.includes("vendo_records") && step < script.length) await script[step++]!();
      return await query(text, params);
    };

    const target = { appId: APP_ID, collection: COLLECTION, owner: "own_thief" };
    const record: RecordInput = { id: ID, data: { who: "thief" } };
    const put = db.transaction((query) => appDataRows({ ...db, query: paced(query) }, target).put(record));

    await expect(put).rejects.toMatchObject({ code: "conflict" });
    expect(step, "the churn never ran — the race was not forced").toBeGreaterThan(0);

    const rows = (await churn.query(
      "SELECT refs, data FROM vendo_records WHERE collection = $1 AND id = $2",
      [SCOPE, ID],
    )).rows as { refs: { subject: string }; data: unknown }[];
    expect(rows).toHaveLength(1);
    const holder = rows[0]!.refs.subject;
    expect(holder, "the put re-stamped a row it had lost").not.toBe("own_thief");
    expect(rows[0]!.data, "the put overwrote the holder's row").toEqual(CHURN[holder as keyof typeof CHURN]);
  });
});
