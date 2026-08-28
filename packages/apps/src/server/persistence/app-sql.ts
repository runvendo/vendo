/**
 * One database per app, reached through one statement at a time.
 *
 * This is the half of the door that talks to an {@link AppDatabase}: it catches
 * the caller's own copy of the app's schema up, runs the guarded statement, and
 * records the schema changes so the next person gets the same tables. The rules
 * about what a statement may SAY live in ./app-sql-guard.ts; the rules about
 * WHERE a table is live here; the adapter under both of them only executes.
 *
 * `shared.x` is one table. `mine.x` is one table PER PERSON — physically, not
 * by a predicate — so ordinary SQL keeps ordinary meaning: a PRIMARY KEY is
 * unique per person, a UNIQUE is per person, and a join is a join. The schema
 * they share is kept identical by a per-app DDL log that every person replays
 * exactly once, lazily, the first time they WRITE to a `mine.` table after it
 * changed.
 *
 * THE CEILING, stated honestly. Replay is per person, so one schema change
 * costs work proportional to the people who hold that table, and each table an
 * app adds makes every later change dearer. Measured on the Cloud rung: ~3 ms
 * per person at 100 tables, ~323 ms at 3,000 — and on a single-threaded object
 * that time lands on somebody's request. A read costs none of it (below), so
 * the curve is indexed on WRITERS, not on everyone who opened the app, which is
 * what keeps it small for a real one.
 *
 * Splitting an app across one database PER PERSON is NOT the way out, and the
 * receipt is why: `shared.` and `mine.` would land in different databases, so
 * `FROM mine.todos JOIN shared.tags` — first-class in the design — becomes
 * unexpressible, one transaction can no longer span the batch, and the
 * bookkeeping reads turn into unbounded fan-outs. The honest answer when this
 * ceiling is reached is that a schema change on a big app IS a migration, and
 * should be surfaced as one rather than hidden inside somebody's next click.
 */
import { createHash } from "node:crypto";
import {
  VendoError,
  type AppDatabase,
  type SqlResult,
  type SqlStatement,
} from "@vendoai/core";
import { guardSql, mineTable, replayFor, sqlRisk, templateOf, unnamespaced } from "./app-sql-guard.js";

/** Which person's copy of a `mine.` table. A digest and not the subject itself
    because a subject is the host's own user id in the host's own spelling —
    `auth0|64f…`, an email, a URL — and none of those fit an SQL identifier. */
const ownerDigest = (subject: string): string =>
  createHash("sha256").update(subject).digest("hex").slice(0, 20);

/** The app's own bookkeeping. `_vendo` is a denied identifier prefix in the
    guard, so no statement an app sends can reach either of these. `seq` is
    assigned by the statement rather than by a sequence, so one spelling serves
    Postgres and SQLite alike. */
const META = [
  'CREATE TABLE IF NOT EXISTS "_vendo_ddl" (seq INTEGER PRIMARY KEY, sql TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS "_vendo_owner" (owner TEXT PRIMARY KEY, seq INTEGER NOT NULL)',
];

const PENDING = 'SELECT sql FROM "_vendo_ddl" WHERE seq > COALESCE((SELECT seq FROM "_vendo_owner" WHERE owner = ?), 0) ORDER BY seq';
const TOP = 'SELECT COALESCE(MAX(seq), 0) AS top FROM "_vendo_ddl"';
/** `seq` is passed IN, never computed in the statement. Computed, a second
    writer that landed between the read and this write would take the number,
    and this insert would fail — which is the honest outcome, and the primary
    key is what produces it. */
const RECORD = 'INSERT INTO "_vendo_ddl" (seq, sql) VALUES (?, ?)';
/** The watermark is the seq this caller ACTUALLY replayed up to — never
    `MAX(seq)`, which would silently skip a statement another writer added after
    the read and leave this person's tables permanently one migration behind. It
    only ever moves FORWARD, so two interleaved requests cannot make one replay
    a statement the other already applied. */
const CAUGHT_UP = 'INSERT INTO "_vendo_owner" (owner, seq) VALUES (?, ?) ON CONFLICT (owner) DO UPDATE SET'
  + ' seq = CASE WHEN "_vendo_owner".seq > excluded.seq THEN "_vendo_owner".seq ELSE excluded.seq END';
/** Postgres only: is any of these qualifiers a real schema rather than a table
    alias? The one question the guard cannot answer on its own. */
const SCHEMAS = "SELECT nspname AS name FROM pg_namespace WHERE nspname = ANY(?::text[])";

/** At most this many rows come back from one statement. A page the model can
    read, not a table dump that fills the context window. */
export const APP_SQL_MAX_ROWS = 500;

/** THIS module's own statements, spelled for the dialect. Never applied to a
    guarded statement: the guard has already numbered its markers, and a "?"
    left in the app's SQL is a character inside a string, not a parameter. */
const spell = (dialect: AppDatabase["dialect"]) => (sql: string, ...params: unknown[]): SqlStatement => {
  let marker = 0;
  return {
    sql: dialect === "postgres" ? sql.replace(/\?/g, () => `$${(marker += 1)}`) : sql,
    ...(params.length === 0 ? {} : { params }),
  };
};

/** A physical name, said the way the app wrote it. */
const spoken = (physical: string, owner: string): string | undefined => {
  if (physical.startsWith("s:")) return `shared.${physical.slice(2)}`;
  const mine = `m:${owner}:`;
  return physical.startsWith(mine) ? `mine.${physical.slice(mine.length)}` : undefined;
};

/** The two engines' ways of saying a table is not there. The sqlite capture is
    colon-SEPARATED rather than colon-greedy on purpose: a physical name is
    `m:<owner>:<table>`, and workerd's message is `no such table: <name>:
    SQLITE_ERROR` — a class that simply allowed ":" swallows the trailing one
    and the app is told `mine.todos: does not exist`. */
const MISSING = /relation "([^"]+)" does not exist|no such table:?\s*([\w.-]+(?::[\w.-]+)*)/i;

export interface AppSqlResult extends SqlResult {
  /** Set when the answer was cut to {@link APP_SQL_MAX_ROWS}. */
  truncated?: true;
}

export interface AppSqlAccess {
  /** Which SQL the app's database speaks — said in the agent tool's own
      description, because generated SQL has to be written for it. */
  readonly dialect: AppDatabase["dialect"];
  /** Run ONE statement as `subject`, against `appId`'s own database. */
  run(appId: string, subject: string, sql: string, params?: readonly unknown[]): Promise<AppSqlResult>;
  /** Erase cascade, subject leg — every `mine.` table this person holds in this
      app, and their place in the schema log. */
  forget(appId: string, subject: string): Promise<void>;
  /** Erase cascade, app leg. */
  drop(appId: string): Promise<void>;
  /**
   * Anonymous → signed-in. `mine.` is a table per person, so adoption MOVES
   * TABLES rather than rewriting an owner column: each table `from` holds is
   * renamed onto `to`, and `to` inherits the schema watermark.
   *
   * The collision — signed in, then anonymous, then signed in again, so `to`
   * already holds that table — is settled by MERGE, and by the rule that the
   * signed-in account never loses a row it already had: the anonymous rows that
   * do not collide are carried across, the ones that do are dropped, and the
   * anonymous copy goes. Refusing instead would strand the work the person just
   * did behind an error nobody can act on.
   */
  adopt(appId: string, from: string, to: string): Promise<void>;
}

export const createAppSql = (db: AppDatabase): AppSqlAccess => {
  const own = spell(db.dialect);
  const cascade = db.dialect === "postgres" ? " CASCADE" : "";

  /** Every logical table the app has, however many people hold a copy. */
  const logical = (tables: readonly string[]): Set<string> => new Set(tables.flatMap((table) =>
    table.startsWith("s:") ? [table.slice(2)]
      : table.startsWith("m:") ? [table.slice(table.indexOf(":", 2) + 1)]
        : []));

  /** The missing-table error, turned into the one sentence that fixes it — or,
      for a read that deliberately did not materialise, into the empty answer
      that is the truth about a table this person has never written to. */
  const explain = async (
    appId: string,
    owner: string,
    error: unknown,
    reading: boolean,
  ): Promise<SqlResult> => {
    const found = MISSING.exec(error instanceof Error ? error.message : String(error));
    if (found === null) throw error;
    const missing = (found[1] ?? found[2]) as string;
    const said = spoken(missing, owner);
    if (said === undefined) unnamespaced(missing);
    const tables = await db.tables(appId);
    if (reading && missing.startsWith("m:") && logical(tables).has(missing.slice(missing.indexOf(":", 2) + 1))) {
      return { columns: [], rows: [], rowCount: 0 };
    }
    const held = [...new Set((tables)
      .map((table) => spoken(table, owner))
      .filter((name): name is string => name !== undefined))];
    throw new VendoError(
      "not-found",
      `${said} does not exist. Every table lives in shared. (all users) or mine. (per-user), and this app has `
      + `${held.length === 0 ? "none yet" : held.join(", ")}. Create it with CREATE TABLE ${said} (…).`,
    );
  };

  return {
    dialect: db.dialect,

    async run(appId, subject, sql, params) {
      const owner = ownerDigest(subject);
      const guarded = guardSql(sql, owner, db.dialect);

      // The two questions that have to be answered BEFORE the statement runs:
      // is a qualifier really a schema, and is this person's copy of the app's
      // schema behind? Both are reads, so they ride one batch of their own —
      // and that batch is a whole extra round trip, which on Cloud is a whole
      // extra HTTP hop, so it only happens when there is really something to
      // ask. A `shared.`-only read with a table alias asks neither and goes
      // straight out.
      // A READ never MATERIALISES. Replaying the schema log creates this
      // person's tables, and doing that for a plain SELECT means everyone who
      // merely OPENS an app pays for a full set of tables — so table count
      // tracked everyone who looked instead of everyone who wrote. A read of a
      // `mine.` table this person has never written answers EMPTY, which is the
      // true answer: they have no rows in it. (One narrow consequence, worth
      // saying rather than hiding: a LEFT JOIN from a materialised table onto a
      // never-touched one answers empty rather than the left rows.)
      const materialise = guarded.mine && (guarded.ddl || sqlRisk(sql) !== "read");
      if (db.maxTables !== undefined && /^\s*create\s+table/i.test(sql)) {
        const held = logical(await db.tables(appId));
        if (held.size >= db.maxTables) {
          throw new VendoError(
            "validation",
            `This app already has its ${db.maxTables} tables (${[...held].sort().join(", ")}), so there is no room `
            + "for another. Drop one it no longer needs, or put the new columns on a table it already has.",
          );
        }
      }
      const replay: SqlStatement[] = [];
      let top = 0;
      const probe = db.dialect === "postgres" && guarded.qualifiers.length > 0;
      if (materialise || probe) {
        const prelude: SqlStatement[] = [
          ...META.map((sql) => own(sql)),
          ...(probe ? [own(SCHEMAS, guarded.qualifiers)] : []),
          ...(materialise ? [own(PENDING, owner), own(TOP)] : []),
        ];
        const answers = await db.run(appId, prelude);
        if (probe) {
          const schema = answers[META.length]?.rows[0]?.["name"];
          if (schema !== undefined) {
            throw new VendoError(
              "validation",
              `"${String(schema)}" is a database schema, not one of this app's tables. An app reaches its own `
              + "tables and nothing else. Write shared.<table> or mine.<table>.",
            );
          }
        }
        if (materialise) {
          top = Number((answers.at(-1) as SqlResult).rows[0]?.["top"] ?? 0);
          for (const row of (answers.at(-2) as SqlResult).rows) {
            replay.push({ sql: replayFor(String(row["sql"]), owner) });
          }
        }
      }

      const statements: SqlStatement[] = [
        ...replay,
        { sql: guarded.sql, ...(params === undefined ? {} : { params }) },
      ];
      const answerAt = statements.length - 1;
      if (materialise) {
        if (guarded.ddl) statements.push(own(RECORD, top + 1, templateOf(guarded.sql, owner)));
        statements.push(own(CAUGHT_UP, owner, guarded.ddl ? top + 1 : top));
      }

      const answers = await db.run(appId, statements)
        .catch((error: unknown) => explain(appId, owner, error, !materialise));
      const answer = Array.isArray(answers) ? answers[answerAt] as SqlResult : answers;
      return answer.rows.length > APP_SQL_MAX_ROWS
        ? { ...answer, rows: answer.rows.slice(0, APP_SQL_MAX_ROWS), truncated: true }
        : answer;
    },

    async forget(appId, subject) {
      const owner = ownerDigest(subject);
      const held = (await db.tables(appId)).filter((table) => table.startsWith(`m:${owner}:`));
      // The same prelude `run` carries, for the same reason: a subject-leg erase
      // sweeps EVERY app, and the bookkeeping only exists in the ones where
      // somebody materialised a `mine.` table. Without it the watermark delete
      // dies on the first neighbour that was never opened.
      await db.run(appId, [
        ...META.map((sql) => own(sql)),
        ...held.map((table) => ({ sql: `DROP TABLE IF EXISTS "${table}"${cascade}` })),
        own('DELETE FROM "_vendo_owner" WHERE owner = ?', owner),
      ]);
    },

    async adopt(appId, from, to) {
      const [was, now] = [ownerDigest(from), ownerDigest(to)];
      if (was === now) return;
      const held = await db.tables(appId);
      const mine = (owner: string): Map<string, string> => new Map(held
        .filter((table) => table.startsWith(`m:${owner}:`))
        .map((table) => [table.slice(table.indexOf(":", 2) + 1), table]));
      const leaving = mine(was);
      if (leaving.size === 0) {
        // Nothing materialised — the common case now that a read never creates
        // tables. One statement, and the anonymous watermark goes with it.
        await db.run(appId, [own('DELETE FROM "_vendo_owner" WHERE owner = ?', was)]);
        return;
      }
      // Both sides go to the head of the log FIRST: a merge does `SELECT *`, so
      // the two copies have to be at the same schema level before either is
      // touched, and the renamed tables carry whatever level they were at.
      const [, , pendingWas, pendingNow, head] = await db.run(appId, [
        ...META.map((sql) => own(sql)),
        own(PENDING, was), own(PENDING, now), own(TOP),
      ]);
      const top = Number((head as SqlResult).rows[0]?.["top"] ?? 0);
      // ONE path, not a rename for the fresh case and a merge for the collision.
      // Catching the target up to head is what makes `SELECT *` parity true, and
      // it necessarily creates the very tables a rename would have moved onto —
      // so a rename can only ever collide with the catch-up that had to happen
      // anyway. Mixing the two also leaves the watermark unable to tell the
      // truth: it is one number per person, and a target that was renamed INTO
      // without being caught up holds tables at two different schema levels.
      const move = [...leaving.values()].flatMap((table) => {
        const target = mineTable(now, table.slice(table.indexOf(":", 2) + 1));
        return [
          {
            sql: db.dialect === "postgres"
              ? `INSERT INTO "${target}" SELECT * FROM "${table}" ON CONFLICT DO NOTHING`
              : `INSERT OR IGNORE INTO "${target}" SELECT * FROM "${table}"`,
          },
          { sql: `DROP TABLE "${table}"${cascade}` },
        ];
      });
      await db.run(appId, [
        ...(pendingWas as SqlResult).rows.map((row) => ({ sql: replayFor(String(row["sql"]), was) })),
        ...(pendingNow as SqlResult).rows.map((row) => ({ sql: replayFor(String(row["sql"]), now) })),
        ...move,
        own(CAUGHT_UP, now, top),
        own('DELETE FROM "_vendo_owner" WHERE owner = ?', was),
      ]);
    },

    drop: (appId) => db.drop(appId),
  };
};

/** Exported for the tests that prove one person's tables have no spelling in
    another's SQL. */
export const appSqlOwner = ownerDigest;
export const appSqlMineTable = mineTable;
