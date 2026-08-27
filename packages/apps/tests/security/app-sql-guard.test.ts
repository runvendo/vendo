/**
 * The door, attacked.
 *
 * Generated SQL is hostile input, and the ONLY thing standing between one
 * person's rows and another's is that no statement can name a physical table.
 * Every case here is an attempt to name one anyway — through a schema, through
 * a second statement, through a quoted identifier, through the catalog, through
 * a rename — and the bar is that each is REFUSED, not merely unlikely to work.
 *
 * The companion to this file is app-sql-postgres.test.ts, which runs the same
 * boundary against a REAL Postgres. This one proves the refusals; that one
 * proves the rows.
 */
import { describe, expect, it } from "vitest";
import { VendoError } from "@vendoai/core";
import { guardSql, mineTable, sharedTable, sqlRisk } from "../../src/server/persistence/app-sql-guard.js";

const ADA = "0123456789abcdef0123";
const GRACE = "fedcba98765432100000";

const guard = (sql: string, owner = ADA): string => guardSql(sql, owner, "postgres").sql;
const refused = (sql: string, owner = ADA): string => {
  try {
    guardSql(sql, owner, "postgres");
  } catch (error) {
    expect(error).toBeInstanceOf(VendoError);
    return (error as VendoError).message;
  }
  throw new Error(`NOT REFUSED: ${sql}`);
};

describe("app SQL guard — the two namespaces", () => {
  it("rewrites mine. to a name that is this person's and nobody else's", () => {
    expect(guard("SELECT * FROM mine.notes")).toContain(`"${mineTable(ADA, "notes")}"`);
    expect(guard("SELECT * FROM mine.notes", GRACE)).toContain(`"${mineTable(GRACE, "notes")}"`);
    expect(guard("SELECT * FROM mine.notes")).not.toContain(GRACE);
  });

  it("rewrites shared. to the one table everybody reads", () => {
    expect(guard("SELECT * FROM shared.catalog")).toContain(`"${sharedTable("catalog")}"`);
    expect(guard("SELECT * FROM shared.catalog", GRACE)).toBe(guard("SELECT * FROM shared.catalog", ADA));
  });

  it("says what happened, why, and the fix when a table has no namespace", () => {
    const message = refused("CREATE TABLE notes (id TEXT PRIMARY KEY)");
    expect(message).toContain("Every table lives in shared. (all users) or mine. (per-user)");
    expect(message).toContain("Did you mean mine.notes?");
  });

  it("reports which statements touch mine. and which change the schema", () => {
    expect(guardSql("SELECT * FROM shared.a", ADA, "postgres")).toMatchObject({ mine: false, ddl: false });
    expect(guardSql("SELECT * FROM mine.a", ADA, "postgres")).toMatchObject({ mine: true, ddl: false });
    expect(guardSql("CREATE TABLE mine.a (id TEXT)", ADA, "postgres")).toMatchObject({ mine: true, ddl: true });
    expect(guardSql("DROP TABLE shared.a", ADA, "postgres")).toMatchObject({ mine: false, ddl: true });
  });
});

describe("app SQL guard — a physical table has no spelling", () => {
  it("refuses a quoted identifier carrying the fence character", () => {
    for (const attack of [
      `SELECT * FROM "${mineTable(GRACE, "notes")}"`,
      `SELECT * FROM "${sharedTable("notes")}"`,
      `INSERT INTO "${mineTable(GRACE, "notes")}" (id) VALUES ('x')`,
    ]) expect(refused(attack)).toContain("is not a name this app can use");
  });

  it("refuses the app database's own bookkeeping", () => {
    for (const attack of [
      "SELECT * FROM _vendo_ddl",
      "SELECT sql FROM _vendo_owner",
      "DELETE FROM _vendo_owner",
      "UPDATE _vendo_owner SET seq = 0",
    ]) expect(refused(attack)).toContain("is reserved");
  });

  it("refuses backtick and bracket quoting, which would dodge the name grammar", () => {
    expect(refused("SELECT * FROM `m:x:notes`")).toContain("not a way to quote a name");
    expect(refused("SELECT * FROM [m:x:notes]")).toContain("not a way to quote a name");
  });

  it("refuses mine./shared. as bare words, so neither can be aliased over", () => {
    expect(refused("SELECT * FROM shared.a AS mine")).toContain("cannot stand on its own");
    expect(refused("SELECT mine FROM shared.a")).toContain("cannot stand on its own");
  });

  it("refuses a three-part name", () => {
    expect(refused("SELECT * FROM mine.notes.x")).toContain("has three parts");
    expect(refused("SELECT * FROM other.public.notes")).toContain("has three parts");
  });
});

describe("app SQL guard — nothing outside the app", () => {
  it("hands every non-namespace qualifier back for the schema check", () => {
    expect(guardSql("SELECT * FROM public.vendo_records", ADA, "postgres").qualifiers).toEqual(["public"]);
    expect(guardSql("SELECT n.title FROM mine.notes n", ADA, "postgres").qualifiers).toEqual(["n"]);
    expect(guardSql("SELECT * FROM mine.a JOIN shared.b ON a.id = b.id", ADA, "postgres").qualifiers)
      .toEqual(["a", "b"]);
  });

  it("refuses the server's catalog by name", () => {
    for (const attack of [
      "SELECT * FROM pg_tables",
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT * FROM information_schema.tables",
      "SELECT * FROM sqlite_master",
      "SELECT lo_import('/etc/passwd')",
      "SELECT * FROM mine.a WHERE id = dblink('x', 'y')",
      "SELECT query_to_xml('SELECT * FROM pg_authid', true, true, '')",
      "SELECT set_config('search_path', 'public', false)",
      "SELECT current_setting('data_directory')",
    ]) expect(refused(attack)).toContain("is reserved");
  });
});

describe("app SQL guard — one statement, from a short list", () => {
  it("refuses a second statement riding the first", () => {
    for (const attack of [
      "SELECT 1; DROP TABLE shared.a",
      "SELECT * FROM mine.a;SELECT * FROM public.vendo_records",
      "  SELECT 1 ;  SELECT 2  ",
    ]) expect(refused(attack)).toContain("Send ONE statement at a time");
  });

  it("leaves a `;` inside a string alone", () => {
    expect(guard("INSERT INTO mine.a (body) VALUES ('one; two')")).toContain("'one; two'");
  });

  it("allows a single trailing semicolon", () => {
    expect(guard("SELECT * FROM mine.a;")).toContain(`"${mineTable(ADA, "a")}"`);
  });

  it("refuses every verb that is not one of the eight", () => {
    for (const attack of [
      "SET search_path = public",
      "SET ROLE postgres",
      "COPY shared.a FROM '/etc/passwd'",
      "DO $$ BEGIN PERFORM 1; END $$",
      "GRANT ALL ON shared.a TO PUBLIC",
      "CREATE SCHEMA evil",
      "CREATE ROLE evil",
      "CREATE FUNCTION f() RETURNS int AS 'SELECT 1' LANGUAGE sql",
      "CREATE TEMP TABLE t (id TEXT)",
      "CREATE VIEW v AS SELECT 1",
      "CREATE INDEX i ON mine.a (id)",
      "TRUNCATE shared.a",
      "BEGIN",
      "COMMIT",
      "VACUUM",
      "ATTACH DATABASE '/tmp/x' AS x",
      "PRAGMA table_info(a)",
      "EXPLAIN SELECT * FROM mine.a",
    ]) expect(refused(attack)).toMatch(/is not something an app's database does|is reserved|Dollar signs/);
  });

  it("refuses SELECT … INTO, which makes an unfenced table", () => {
    expect(refused("SELECT * INTO evil FROM shared.a")).toContain("SELECT … INTO");
    expect(guard("INSERT INTO mine.a (id) VALUES ('x')")).toContain("INSERT INTO");
  });

  it("refuses the ALTER TABLE subcommands that change the fence, not the columns", () => {
    expect(guard("ALTER TABLE mine.a ADD COLUMN done BOOLEAN")).toContain("ADD COLUMN");
    expect(guard("ALTER TABLE mine.a RENAME COLUMN a TO b")).toContain("RENAME COLUMN");
    expect(refused("ALTER TABLE mine.a RENAME TO evil")).toContain("cannot be renamed");
    // Both are caught by the subcommand rule before the word-pair rule ever
    // sees them — the earlier refusal wins, and either one is a refusal.
    expect(refused("ALTER TABLE mine.a SET SCHEMA public")).toContain("ALTER TABLE may only");
    expect(refused("ALTER TABLE mine.a OWNER TO postgres")).toContain("ALTER TABLE may only");
    expect(refused("ALTER TABLE mine.a ENABLE ROW LEVEL SECURITY")).toContain("ALTER TABLE may only");
    expect(refused("ALTER TABLE mine.a DISABLE TRIGGER ALL")).toContain("ALTER TABLE may only");
  });

  it("refuses a named constraint, whose backing index would collide across people", () => {
    expect(refused("CREATE TABLE mine.a (id TEXT CONSTRAINT a_pk PRIMARY KEY)")).toContain("is reserved");
    expect(guard("CREATE TABLE mine.a (id TEXT PRIMARY KEY, slug TEXT UNIQUE)"))
      .toContain(`"${mineTable(ADA, "a")}"`);
  });

  it("refuses a DDL target with no namespace", () => {
    for (const attack of ["CREATE TABLE x (id TEXT)", "DROP TABLE x", "ALTER TABLE x ADD COLUMN y TEXT"]) {
      expect(refused(attack)).toContain("Every table lives in shared.");
    }
  });
});

describe("app SQL guard — comments, strings and markers", () => {
  it("strips comments before anything else reads the statement", () => {
    expect(guard("SELECT * FROM mine.a -- ; DROP TABLE shared.b")).not.toContain("DROP");
    expect(guard("SELECT /* mine.b */ * FROM mine.a")).not.toContain("mine.b");
  });

  it("never rewrites inside a string", () => {
    expect(guard("INSERT INTO mine.a (body) VALUES ('mine.notes and pg_tables')"))
      .toContain("'mine.notes and pg_tables'");
  });

  it("numbers ? markers for postgres and leaves them for sqlite", () => {
    expect(guard("INSERT INTO mine.a (x, y) VALUES (?, ?)")).toContain("VALUES ($1, $2)");
    expect(guardSql("INSERT INTO mine.a (x, y) VALUES (?, ?)", ADA, "sqlite").sql).toContain("VALUES (?, ?)");
  });

  it("does not number a ? that is inside a string", () => {
    expect(guard("INSERT INTO mine.a (body, x) VALUES ('what?', ?)")).toContain("'what?', $1");
  });

  it("refuses dollar-quoting and dollar markers outright", () => {
    expect(refused("SELECT $$ x $$")).toContain("Dollar signs");
    expect(refused("SELECT * FROM mine.a WHERE id = $1")).toContain("Dollar signs");
  });

  it("refuses an unterminated string, comment or quoted name", () => {
    expect(refused("SELECT 'x")).toContain("ends inside a '…' string");
    expect(refused("SELECT /* x")).toContain("ends inside a /* comment");
    expect(refused('SELECT "x')).toContain("ends inside a");
  });
});

describe("app SQL guard — the name grammar", () => {
  it("refuses a table name longer than the physical name can carry", () => {
    expect(refused(`SELECT * FROM mine.${"a".repeat(29)}`)).toContain("is not a table name this app can use");
    expect(guard(`SELECT * FROM mine.${"a".repeat(28)}`)).toContain("a".repeat(28));
  });

  it("folds names to one case, so mine.Notes and mine.notes are one table", () => {
    expect(guard("SELECT * FROM mine.Notes")).toBe(guard("SELECT * FROM mine.notes"));
    expect(guard('SELECT * FROM mine."NOTES"')).toBe(guard("SELECT * FROM mine.notes"));
  });

  it("refuses an empty statement with the shape of the fix", () => {
    expect(refused("   ")).toContain("SELECT * FROM mine.notes");
  });
});

describe("app SQL risk", () => {
  it("grades a read down so a running app's query takes the query arm", () => {
    expect(sqlRisk("SELECT * FROM mine.a")).toBe("read");
    expect(sqlRisk("  with x as (select 1) select * from x")).toBe("read");
  });

  it("grades anything that could write as a write, and a drop as destructive", () => {
    expect(sqlRisk("INSERT INTO mine.a (id) VALUES ('x')")).toBe("write");
    expect(sqlRisk("WITH x AS (INSERT INTO mine.a (id) VALUES ('x')) SELECT * FROM x")).toBe("write");
    expect(sqlRisk("UPDATE mine.a SET x = 1")).toBe("write");
    expect(sqlRisk("CREATE TABLE mine.a (id TEXT)")).toBe("write");
    expect(sqlRisk("DROP TABLE mine.a")).toBe("destructive");
    expect(sqlRisk("gibberish")).toBe("write");
  });
});
