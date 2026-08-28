/**
 * The app-database SEAM, end to end, with nothing stubbed on either side.
 *
 * Producer: `@vendoai/apps`' real door — the guard, the physical names, the
 * per-owner schema replay. Consumer: this package's real Postgres adapter over
 * a real Postgres engine. A harness that mocked either half would prove only
 * that it agrees with itself, which is the exact failure this repo has shipped
 * four times.
 *
 * The engine here is PGlite — a real Postgres compiled to wasm, so schemas,
 * `search_path` and `pg_namespace` all behave — and it needs no server, so this
 * suite CANNOT skip itself. A run against a real Postgres 16 server is the rig
 * in the storage lane's report; this is the one that gates every commit.
 *
 * The adversarial half is the point: Grace tries to read, write, delete and
 * enumerate Ada's rows, by every address the door might have left open.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAppSql, type AppSqlAccess } from "@vendoai/apps";
import { VendoError } from "@vendoai/core";
import { appSchema, createStore, postgresAppDatabase, type VendoStore } from "../src/index.js";

const ADA = "auth0|ada";
const GRACE = "https://idp.example/u/grace";
let store: VendoStore;
let sql: AppSqlAccess;
/** ONE engine for the file, and a fresh APP per test. An app's database is a
    schema of its own, so a new app id IS a clean slate — and booting a PGlite
    per test costs most of a minute each on a busy machine, which is a speed
    limit the suite would then blame on the product. */
let APP = "app_tracker";

beforeAll(async () => {
  store = createStore({ dataDir: `memory://app-db-${process.pid}` });
  await store.ensureSchema();
  const db = postgresAppDatabase(store);
  expect(db).toBeDefined();
  sql = createAppSql(db!);
});

beforeEach(() => {
  APP = `app_${Math.random().toString(36).slice(2, 10)}`;
});

afterAll(async () => {
  await store.close();
});

const run = (subject: string, statement: string, params?: unknown[]) =>
  sql.run(APP, subject, statement, params);

const refused = async (subject: string, statement: string, params?: unknown[]): Promise<string> => {
  try {
    await run(subject, statement, params);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`NOT REFUSED: ${statement}`);
};

describe("app database — zero configuration", () => {
  it("composes off the store the host already wired, and speaks postgres", () => {
    expect(sql.dialect).toBe("postgres");
  });

  it("has no adapter for a store with no SQL handle behind it", () => {
    expect(postgresAppDatabase({} as VendoStore)).toBeUndefined();
  });

  it("keeps each app in its own schema", async () => {
    await run(ADA, "CREATE TABLE shared.a (id TEXT PRIMARY KEY)");
    const here = await store.records("vendo_apps"); // any real read, to prove the store still works
    expect(here).toBeDefined();
    expect(appSchema(APP)).not.toBe(appSchema("app_other"));
    // Two apps, one name, two tables.
    await sql.run("app_other", ADA, "CREATE TABLE shared.a (id TEXT PRIMARY KEY, extra TEXT)");
    await run(ADA, "INSERT INTO shared.a (id) VALUES ('here')");
    expect((await sql.run("app_other", ADA, "SELECT * FROM shared.a")).rows).toEqual([]);
  });
});

describe("app database — shared. is one table", () => {
  beforeEach(async () => {
    await run(ADA, "CREATE TABLE shared.catalog (id TEXT PRIMARY KEY, title TEXT)");
  });

  it("shows one person's write to everybody, through the real read path", async () => {
    await run(ADA, "INSERT INTO shared.catalog (id, title) VALUES (?, ?)", ["sku1", "Blue mug"]);
    const seen = await run(GRACE, "SELECT title FROM shared.catalog WHERE id = ?", ["sku1"]);
    expect(seen.rows).toEqual([{ title: "Blue mug" }]);
    expect(seen.columns).toEqual(["title"]);
  });

  it("counts what a mutation affected", async () => {
    await run(ADA, "INSERT INTO shared.catalog (id, title) VALUES ('a', 'A')");
    await run(ADA, "INSERT INTO shared.catalog (id, title) VALUES ('b', 'B')");
    expect((await run(GRACE, "UPDATE shared.catalog SET title = 'X'")).rowCount).toBe(2);
    expect((await run(GRACE, "DELETE FROM shared.catalog WHERE id = 'a'")).rowCount).toBe(1);
  });
});

describe("app database — mine. is one person's rows", () => {
  beforeEach(async () => {
    await run(ADA, "CREATE TABLE mine.todos (id TEXT PRIMARY KEY, title TEXT, done BOOLEAN DEFAULT FALSE)");
  });

  it("round-trips a row through the real write path and the real read path", async () => {
    await run(ADA, "INSERT INTO mine.todos (id, title) VALUES (?, ?)", ["t1", "ada's task"]);
    expect((await run(ADA, "SELECT title FROM mine.todos")).rows).toEqual([{ title: "ada's task" }]);
  });

  it("gives a second person the same schema and none of the rows", async () => {
    await run(ADA, "INSERT INTO mine.todos (id, title) VALUES ('t1', 'ada')");
    // Grace has never touched this app; the schema replay makes her table on
    // first use, and it is EMPTY.
    expect((await run(GRACE, "SELECT * FROM mine.todos")).rows).toEqual([]);
    await run(GRACE, "INSERT INTO mine.todos (id, title) VALUES ('t1', 'grace')");
    expect((await run(ADA, "SELECT title FROM mine.todos")).rows).toEqual([{ title: "ada" }]);
    expect((await run(GRACE, "SELECT title FROM mine.todos")).rows).toEqual([{ title: "grace" }]);
  });

  it("keeps a PRIMARY KEY unique PER PERSON, which is what ordinary SQL means here", async () => {
    await run(ADA, "CREATE TABLE mine.settings (key TEXT PRIMARY KEY, value TEXT)");
    await run(ADA, "INSERT INTO mine.settings (key, value) VALUES ('theme', 'dark')");
    // The same key, for a different person, is not a collision — this is the
    // case a shared table with an owner column silently breaks.
    await run(GRACE, "INSERT INTO mine.settings (key, value) VALUES ('theme', 'light')");
    expect((await run(ADA, "SELECT value FROM mine.settings")).rows).toEqual([{ value: "dark" }]);
    expect((await run(GRACE, "SELECT value FROM mine.settings")).rows).toEqual([{ value: "light" }]);
  });

  it("replays a later ALTER onto a person who has not been seen since", async () => {
    await run(ADA, "INSERT INTO mine.todos (id, title) VALUES ('t1', 'ada')");
    await run(ADA, "ALTER TABLE mine.todos ADD COLUMN due TEXT");
    await run(ADA, "UPDATE mine.todos SET due = '2026-09-01'");
    // Grace's first ever touch: both the CREATE and the ALTER replay, in order.
    const graceSees = await run(GRACE, "SELECT id, due FROM mine.todos");
    expect(graceSees.rows).toEqual([]);
    expect(graceSees.columns).toEqual([]);
    await run(GRACE, "INSERT INTO mine.todos (id, title, due) VALUES ('g1', 'grace', '2026-10-01')");
    expect((await run(GRACE, "SELECT due FROM mine.todos")).rows).toEqual([{ due: "2026-10-01" }]);
    expect((await run(ADA, "SELECT due FROM mine.todos")).rows).toEqual([{ due: "2026-09-01" }]);
  });

  // The watermark must be what this caller actually replayed, not the log's
  // MAX — otherwise a DDL that lands between the read and the write is skipped
  // for this person forever, and their table is one migration behind with
  // nothing to say so.
  it("never skips a schema change that landed while it was catching up", async () => {
    await run(ADA, "ALTER TABLE mine.todos ADD COLUMN due TEXT");
    // A second app-sql handle is a second writer: it adds a column while Grace
    // has replayed nothing at all.
    const other = createAppSql(postgresAppDatabase(store)!);
    await other.run(APP, ADA, "ALTER TABLE mine.todos ADD COLUMN note TEXT");
    await run(GRACE, "INSERT INTO mine.todos (id, title, due, note) VALUES ('g', 'grace', 'd', 'n')");
    expect((await run(GRACE, "SELECT note FROM mine.todos")).rows).toEqual([{ note: "n" }]);
  });

  it("replays a DROP too, so a table that is gone is gone for everybody", async () => {
    await run(GRACE, "SELECT * FROM mine.todos"); // Grace is caught up
    await run(ADA, "DROP TABLE mine.todos");
    expect(await refused(GRACE, "SELECT * FROM mine.todos")).toContain("mine.todos does not exist");
  });

  it("lets shared. and mine. join", async () => {
    await run(ADA, "CREATE TABLE shared.tags (id TEXT PRIMARY KEY, label TEXT)");
    await run(ADA, "INSERT INTO shared.tags (id, label) VALUES ('t1', 'home')");
    await run(ADA, "INSERT INTO mine.todos (id, title) VALUES ('t1', 'sweep')");
    const joined = await run(ADA, "SELECT m.title, s.label FROM mine.todos m JOIN shared.tags s ON s.id = m.id");
    expect(joined.rows).toEqual([{ title: "sweep", label: "home" }]);
  });
});

describe("app database — Grace cannot reach Ada's rows", () => {
  beforeEach(async () => {
    await run(ADA, "CREATE TABLE mine.secrets (id TEXT PRIMARY KEY, body TEXT)");
    await run(ADA, "INSERT INTO mine.secrets (id, body) VALUES ('s1', 'ada only')");
  });

  it("refuses the physical table by its real name, even when it is known", async () => {
    const tables = await postgresAppDatabase(store)!.tables(APP);
    const adasTable = tables.find((table) => table.startsWith("m:") && table.endsWith(":secrets"));
    expect(adasTable).toBeDefined();
    // The attacker is HANDED the exact physical name. It is still unwritable.
    expect(await refused(GRACE, `SELECT * FROM "${adasTable}"`)).toContain("is not a name this app can use");
  });

  it("refuses the app's own schema by name — the fence is not an address either", async () => {
    expect(await refused(GRACE, `SELECT * FROM ${appSchema(APP)}.x`))
      .toContain("is a database schema, not one of this app's tables");
  });

  it("refuses another schema in the same database", async () => {
    const message = await refused(GRACE, "SELECT * FROM public.vendo_records");
    expect(message).toContain('"public" is a database schema, not one of this app\'s tables');
  });

  it("refuses the host's own tables reached without a schema", async () => {
    // An unqualified name resolves inside the app's namespace and NOWHERE else,
    // so the host's `vendo_records` is invisible even without a qualifier.
    expect(await refused(GRACE, "SELECT * FROM vendo_records")).toContain("Every table lives in shared.");
  });

  it("refuses the schema log that would name every other person's table", async () => {
    expect(await refused(GRACE, "SELECT * FROM _vendo_owner")).toContain("is reserved");
    expect(await refused(GRACE, "SELECT * FROM pg_tables")).toContain("is reserved");
    expect(await refused(GRACE, "SELECT * FROM information_schema.tables")).toContain("is reserved");
  });

  it("leaves Ada's row untouched after every attempt", async () => {
    for (const attack of [
      "DELETE FROM mine.secrets",
      "UPDATE mine.secrets SET body = 'stolen'",
      "DROP TABLE mine.secrets; SELECT 1",
      "SELECT * FROM public.vendo_records",
    ]) await run(GRACE, attack).catch(() => undefined);
    expect((await run(ADA, "SELECT body FROM mine.secrets")).rows).toEqual([{ body: "ada only" }]);
  });

  // The Cloud half found `REPLACE INTO mine.t` deleting whatever row held the
  // key before inserting — a row that could be another person's. That whole
  // class cannot exist here: `mine.x` is a SEPARATE TABLE per person, so no key
  // reaches another person's row and there is nothing to delete-then-write
  // across the fence. Proven, not assumed.
  it("cannot destroy another person's row by writing to the same key", async () => {
    await run(GRACE, "SELECT * FROM mine.secrets"); // Grace's own table exists
    await run(GRACE, "INSERT INTO mine.secrets (id, body) VALUES ('s1', 'grace only')");
    for (const upsert of [
      "INSERT INTO mine.secrets (id, body) VALUES ('s1', 'clobbered') ON CONFLICT (id) DO UPDATE SET body = excluded.body",
      "DELETE FROM mine.secrets WHERE id = 's1'",
      "UPDATE mine.secrets SET body = 'clobbered' WHERE id = 's1'",
    ]) await run(GRACE, upsert);
    expect((await run(ADA, "SELECT body FROM mine.secrets")).rows).toEqual([{ body: "ada only" }]);
  });

  it("refuses the verbs that delete-then-write by key", async () => {
    for (const attack of [
      "REPLACE INTO mine.secrets (id, body) VALUES ('s1', 'stolen')",
      "MERGE INTO mine.secrets USING shared.x ON TRUE WHEN MATCHED THEN DELETE",
      "TRUNCATE mine.secrets",
    ]) expect(await refused(GRACE, attack)).toContain("is not something an app's database does");
  });

  // The fence rides with the NAME, so it is the same fence wherever the name
  // appears — there is no "outside a join" for it to be weaker in. Proven in
  // every position a table reference can take.
  it("holds the same in a join, a CTE, a subquery and a UNION arm", async () => {
    await run(GRACE, "SELECT * FROM mine.secrets"); // Grace's own table exists
    await run(GRACE, "INSERT INTO mine.secrets (id, body) VALUES ('s1', 'grace only')");
    for (const shape of [
      "SELECT a.body FROM mine.secrets a JOIN mine.secrets b ON a.id = b.id",
      "WITH t AS (SELECT body FROM mine.secrets) SELECT * FROM t",
      "SELECT body FROM mine.secrets WHERE id IN (SELECT id FROM mine.secrets)",
      "SELECT body FROM mine.secrets UNION SELECT body FROM mine.secrets",
      "SELECT (SELECT body FROM mine.secrets LIMIT 1) AS body",
    ]) expect((await run(GRACE, shape)).rows).toEqual([{ body: "grace only" }]);
  });

  it("still sees nothing when Grace names Ada's subject in her own SQL", async () => {
    // There is no field for a subject and no address for one. The closest a
    // statement can come is putting it in a string, which is just a string.
    const seen = await run(GRACE, "SELECT * FROM mine.secrets WHERE body = ?", [ADA]);
    expect(seen.rows).toEqual([]);
  });
});

describe("app database — a read that comes back through a different handle", () => {
  it("is still there when a second process opens the same data directory", async () => {
    const dir = `/tmp/vendo-app-db-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const first = createStore({ dataDir: dir });
    await first.ensureSchema();
    await createAppSql(postgresAppDatabase(first)!).run(
      APP, ADA, "CREATE TABLE mine.notes (id TEXT PRIMARY KEY, body TEXT)",
    );
    await createAppSql(postgresAppDatabase(first)!).run(
      APP, ADA, "INSERT INTO mine.notes (id, body) VALUES ('n1', 'written first')",
    );
    await first.close();

    const second = createStore({ dataDir: dir });
    await second.ensureSchema();
    const back = await createAppSql(postgresAppDatabase(second)!).run(APP, ADA, "SELECT body FROM mine.notes");
    expect(back.rows).toEqual([{ body: "written first" }]);
    await second.close();
  });
});

describe("app database — the erase cascade", () => {
  beforeEach(async () => {
    await run(ADA, "CREATE TABLE mine.rows (id TEXT PRIMARY KEY)");
    await run(ADA, "INSERT INTO mine.rows (id) VALUES ('a')");
    await run(GRACE, "INSERT INTO mine.rows (id) VALUES ('g')");
    await run(ADA, "CREATE TABLE shared.common (id TEXT PRIMARY KEY)");
  });

  it("forgets ONE person's tables and spares everyone else's", async () => {
    await sql.forget(APP, ADA);
    expect((await run(GRACE, "SELECT id FROM mine.rows")).rows).toEqual([{ id: "g" }]);
    // Ada comes back to an empty table, rebuilt from the schema log.
    expect((await run(ADA, "SELECT id FROM mine.rows")).rows).toEqual([]);
  });

  it("drops the whole app database with the app", async () => {
    await sql.drop(APP);
    expect(await postgresAppDatabase(store)!.tables(APP)).toEqual([]);
  });
});

describe("app database — what the tool answers with", () => {
  it("names the tables the app really has when one is missing", async () => {
    await run(ADA, "CREATE TABLE shared.catalog (id TEXT PRIMARY KEY)");
    await run(ADA, "CREATE TABLE mine.todos (id TEXT PRIMARY KEY)");
    const message = await refused(ADA, "SELECT * FROM mine.nope");
    expect(message).toContain("mine.nope does not exist");
    expect(message).toContain("shared.catalog");
    expect(message).toContain("mine.todos");
  });

  it("says so when a bare name was meant to be a table", async () => {
    const message = await refused(ADA, "SELECT * FROM todos");
    expect(message).toContain("Every table lives in shared. (all users) or mine. (per-user)");
    expect(message).toContain("Did you mean mine.todos?");
  });

  it("refuses with a VendoError, so the tool answers instead of crashing", async () => {
    await expect(run(ADA, "DROP DATABASE postgres")).rejects.toBeInstanceOf(VendoError);
  });
});
