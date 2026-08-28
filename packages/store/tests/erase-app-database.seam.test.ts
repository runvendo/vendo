/**
 * The erase cascade's app-database leg, at the SEAM.
 *
 * The storage rebuild moved an app's own data out of `vendo_records` /
 * `vendo_blobs` and into a SQL database of its own — and the cascade did not
 * follow it. `eraseStore().byApp()` and `.bySubject()` went on deleting
 * `vendo_*` rows, `createStoreOps` had no app-database parameter at all, and
 * `AppSqlAccess.forget` — the function whose doc-comment reads "erase cascade,
 * subject leg" — had zero production callers. The old path erased the app's
 * records and blobs in BOTH cascades, so this was a regression, and a GDPR one:
 * a deletion request answered with a receipt while every row was still readable.
 *
 * The tests that would have caught it went in the same commit
 * (`3c98517a0`), and the core conformance case kept the name
 * "lifecycle.erase removes one app's data" over assertions that no longer
 * touched an app's data. This file is what that name has to mean now.
 *
 * NOTHING is stubbed on either side. The WRITE path is `@vendoai/apps`' real
 * door — the guard, the physical names, the per-owner schema replay. The READ
 * BACK is the same real door and this package's real Postgres adapter over a
 * real Postgres (PGlite: real schemas, real `search_path`, real
 * `pg_namespace`), so the suite cannot skip itself. A harness that mocked
 * either half would only prove the two halves agree.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppSql, type AppSqlAccess } from "@vendoai/apps";
import {
  createStore,
  createStoreOps,
  eraseStore,
  postgresAppDatabase,
  storeFiles,
  type VendoStore,
} from "../src/index.js";
import { appFixture } from "../src/fixtures.test-util.js";

const ADA = "auth0|ada";
const GRACE = "https://idp.example/u/grace";
const ORG = "org_maple";

let store: VendoStore;
let sql: AppSqlAccess;

/** An app row, owned by `subject` — what both cascades select on. */
const seedApp = async (id: string, subject: string): Promise<string> => {
  const doc = appFixture(id);
  await store.records("vendo_apps").put({
    id,
    data: { subject, enabled: true, doc },
    refs: { subject },
  });
  return id;
};

/** Read back through the app's OWN door, as the app itself would. */
const rowsOf = async (appId: string, subject: string, table: string): Promise<unknown[]> =>
  (await sql.run(appId, subject, `SELECT body FROM ${table}`)).rows.map((row) => row["body"]);

const tablesOf = (appId: string): Promise<string[]> => postgresAppDatabase(store)!.tables(appId);

beforeEach(async () => {
  store = createStore({ dataDir: `memory://erase-app-db-${process.pid}-${Math.random().toString(36).slice(2)}` });
  await store.ensureSchema();
  sql = createAppSql(postgresAppDatabase(store)!);
});

afterEach(async () => {
  await store.close();
});

describe("erase cascade — one app's SQL database goes with the app", () => {
  it("byApp removes the app's data, and only that app's", async () => {
    const gone = await seedApp("app_gone", ADA);
    const stays = await seedApp("app_stays", ADA);
    for (const appId of [gone, stays]) {
      await sql.run(appId, ADA, "CREATE TABLE shared.notes (id TEXT PRIMARY KEY, body TEXT)");
      await sql.run(appId, ADA, "INSERT INTO shared.notes (id, body) VALUES ('n', ?)", [appId]);
      await sql.run(appId, GRACE, "CREATE TABLE mine.drafts (id TEXT PRIMARY KEY, body TEXT)");
      await sql.run(appId, GRACE, "INSERT INTO mine.drafts (id, body) VALUES ('d', ?)", [appId]);
    }
    // The premise: both apps really hold rows, through the real read path.
    expect(await rowsOf(gone, ADA, "shared.notes")).toEqual([gone]);
    expect(await rowsOf(gone, GRACE, "mine.drafts")).toEqual([gone]);

    await eraseStore(store, { files: storeFiles(store), appSql: sql }).byApp(gone);

    // `shared.` AND every person's `mine.` — the whole database, not a table.
    expect(await tablesOf(gone)).toEqual([]);
    expect(await rowsOf(gone, ADA, "shared.notes").catch(() => "refused")).toBe("refused");

    // The app NEXT to it keeps everything, both namespaces, both people.
    expect(await rowsOf(stays, ADA, "shared.notes")).toEqual([stays]);
    expect(await rowsOf(stays, GRACE, "mine.drafts")).toEqual([stays]);
  });

  it("bySubject takes the whole database of an app the person OWNED", async () => {
    const owned = await seedApp("app_owned", ADA);
    await sql.run(owned, ADA, "CREATE TABLE shared.notes (id TEXT PRIMARY KEY, body TEXT)");
    await sql.run(owned, ADA, "INSERT INTO shared.notes (id, body) VALUES ('n', 'ada wrote this')");
    // Grace's rows inside Ada's app go too: the app is Ada's, and it goes whole.
    await sql.run(owned, GRACE, "CREATE TABLE mine.drafts (id TEXT PRIMARY KEY, body TEXT)");
    await sql.run(owned, GRACE, "INSERT INTO mine.drafts (id, body) VALUES ('d', 'grace draft')");

    await eraseStore(store, { files: storeFiles(store), appSql: sql }).bySubject(ADA);

    expect(await tablesOf(owned)).toEqual([]);
  });

  /**
   * The other leg, and the one a blanket `drop` would get wrong. Build contract
   * §9.7: an org app carries the ORG in `subject`, so erasing a member never
   * reaches the app row — but the member's own `mine.` tables inside it are
   * still their data, and outlived them until this leg existed. Before the
   * rebuild this was the `namespace LIKE 'app:%' AND key LIKE '<subject>/%'`
   * blob selector; it is the same leg, moved to where the data went.
   */
  it("bySubject takes only the person's own tables inside an app they merely USED", async () => {
    const orgApp = await seedApp("app_org", ORG);
    await sql.run(orgApp, ADA, "CREATE TABLE mine.drafts (id TEXT PRIMARY KEY, body TEXT)");
    await sql.run(orgApp, ADA, "INSERT INTO mine.drafts (id, body) VALUES ('d', 'ada draft')");
    await sql.run(orgApp, GRACE, "INSERT INTO mine.drafts (id, body) VALUES ('d', 'grace draft')");
    await sql.run(orgApp, ADA, "CREATE TABLE shared.board (id TEXT PRIMARY KEY, body TEXT)");
    await sql.run(orgApp, ADA, "INSERT INTO shared.board (id, body) VALUES ('b', 'the team board')");

    await eraseStore(store, { files: storeFiles(store), appSql: sql }).bySubject(ADA);

    // The org's app survives its departing member...
    expect(await store.records("vendo_apps").get(orgApp)).not.toBeNull();
    // ...and so does everybody else's work in it.
    expect(await rowsOf(orgApp, GRACE, "mine.drafts")).toEqual(["grace draft"]);
    expect(await rowsOf(orgApp, GRACE, "shared.board")).toEqual(["the team board"]);
    // Ada's own rows are gone. She comes back to an EMPTY table, rebuilt from
    // the schema log — the honest answer for a person with no rows.
    expect(await rowsOf(orgApp, ADA, "mine.drafts")).toEqual([]);
  });

  /**
   * The subject leg has to survive the apps this person never went near, and
   * most deployments are mostly those. An app database only grows its
   * bookkeeping (`_vendo_ddl` / `_vendo_owner`) when somebody materialises a
   * `mine.` table in it, so an app that was never opened — or that only ever
   * used `shared.` — has none, and `AppSqlAccess.forget` deletes its watermark
   * row unconditionally: `relation "_vendo_owner" does not exist`, and the
   * whole erase dies on a neighbour it had nothing to do.
   *
   * That is the reason `forget` had zero production callers to begin with: it
   * could never be called on an arbitrary app. Its batch needs the same
   * `CREATE TABLE IF NOT EXISTS` prelude `run` already carries.
   */
  it("bySubject survives the apps this person never touched", async () => {
    const used = await seedApp("app_used", ADA);
    await sql.run(used, ADA, "CREATE TABLE mine.notes (id TEXT PRIMARY KEY, body TEXT)");
    await sql.run(used, ADA, "INSERT INTO mine.notes (id, body) VALUES ('n', 'ada')");
    // A neighbour Ada never opened, and one that only ever held a `shared.`
    // table — neither has any bookkeeping for the cascade to delete from.
    await seedApp("app_never_opened", GRACE);
    const sharedOnly = await seedApp("app_shared_only", GRACE);
    await sql.run(sharedOnly, GRACE, "CREATE TABLE shared.board (id TEXT PRIMARY KEY, body TEXT)");
    await sql.run(sharedOnly, GRACE, "INSERT INTO shared.board (id, body) VALUES ('b', 'grace board')");

    await eraseStore(store, { files: storeFiles(store), appSql: sql }).bySubject(ADA);

    expect(await tablesOf(used)).toEqual([]);
    // The neighbours are untouched, and the one with rows still has them.
    expect(await rowsOf(sharedOnly, GRACE, "shared.board")).toEqual(["grace board"]);
  });

  it("is re-runnable, like the rest of the cascade", async () => {
    const app = await seedApp("app_twice", ADA);
    await sql.run(app, ADA, "CREATE TABLE shared.notes (id TEXT PRIMARY KEY, body TEXT)");
    const doors = eraseStore(store, { files: storeFiles(store), appSql: sql });
    await doors.byApp(app);
    await doors.byApp(app);
    await doors.bySubject(ADA);
    expect(await tablesOf(app)).toEqual([]);
  });
});

describe("erase cascade — the ops surface carries the same leg", () => {
  /** `lifecycle.erase` is the door a host actually calls, and the one the
      console calls over the store wire. It reached `eraseStore` without an
      app-database parameter to hand it, so every erase through it left the app
      tables standing. */
  it("lifecycle.erase drops the app's database through the composed ops surface", async () => {
    const app = await seedApp("app_ops", ADA);
    await sql.run(app, ADA, "CREATE TABLE shared.notes (id TEXT PRIMARY KEY, body TEXT)");
    await sql.run(app, ADA, "INSERT INTO shared.notes (id, body) VALUES ('n', 'private')");
    const ops = createStoreOps(store, { files: storeFiles(store), appSql: sql });

    const report = await ops.lifecycle.erase({ appId: app });

    expect(report).toBeDefined();
    expect(await tablesOf(app)).toEqual([]);
  });

  it("does the same on the subject axis", async () => {
    const app = await seedApp("app_ops_subject", ADA);
    await sql.run(app, ADA, "CREATE TABLE mine.notes (id TEXT PRIMARY KEY, body TEXT)");
    await sql.run(app, ADA, "INSERT INTO mine.notes (id, body) VALUES ('n', 'private')");
    const ops = createStoreOps(store, { files: storeFiles(store), appSql: sql });

    await ops.lifecycle.erase({ subject: ADA });

    expect(await tablesOf(app)).toEqual([]);
  });
});
