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
 * exactly once, lazily, the first time they touch a `mine.` table after it
 * changed.
 */
import { createHash } from "node:crypto";
import {
  VendoError,
  type AppDatabase,
  type SqlResult,
  type SqlStatement,
} from "@vendoai/core";
import { guardSql, mineTable, replayFor, templateOf, unnamespaced } from "./app-sql-guard.js";

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

const MISSING = /relation "([^"]+)" does not exist|no such table:?\s*([\w:.-]+)/i;

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
}

export const createAppSql = (db: AppDatabase): AppSqlAccess => {
  const own = spell(db.dialect);
  const cascade = db.dialect === "postgres" ? " CASCADE" : "";

  /** The missing-table error, turned into the one sentence that fixes it. */
  const explain = async (appId: string, owner: string, error: unknown): Promise<never> => {
    const found = MISSING.exec(error instanceof Error ? error.message : String(error));
    if (found === null) throw error;
    const missing = (found[1] ?? found[2]) as string;
    const said = spoken(missing, owner);
    if (said === undefined) unnamespaced(missing);
    const held = (await db.tables(appId))
      .map((table) => spoken(table, owner))
      .filter((name): name is string => name !== undefined);
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
      // schema behind? Both are reads, so they ride one batch of their own.
      const replay: SqlStatement[] = [];
      let top = 0;
      if (guarded.mine || guarded.qualifiers.length > 0) {
        const probe = db.dialect === "postgres" && guarded.qualifiers.length > 0;
        const prelude: SqlStatement[] = [
          ...META.map((sql) => own(sql)),
          ...(probe ? [own(SCHEMAS, guarded.qualifiers)] : []),
          ...(guarded.mine ? [own(PENDING, owner), own(TOP)] : []),
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
        if (guarded.mine) {
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
      if (guarded.mine) {
        if (guarded.ddl) statements.push(own(RECORD, top + 1, templateOf(guarded.sql, owner)));
        statements.push(own(CAUGHT_UP, owner, guarded.ddl ? top + 1 : top));
      }

      const answers = await db.run(appId, statements).catch((error: unknown) => explain(appId, owner, error));
      const answer = answers[answerAt] as SqlResult;
      return answer.rows.length > APP_SQL_MAX_ROWS
        ? { ...answer, rows: answer.rows.slice(0, APP_SQL_MAX_ROWS), truncated: true }
        : answer;
    },

    async forget(appId, subject) {
      const owner = ownerDigest(subject);
      const held = (await db.tables(appId)).filter((table) => table.startsWith(`m:${owner}:`));
      await db.run(appId, [
        ...held.map((table) => ({ sql: `DROP TABLE IF EXISTS "${table}"${cascade}` })),
        own('DELETE FROM "_vendo_owner" WHERE owner = ?', owner),
      ]);
    },

    drop: (appId) => db.drop(appId),
  };
};

/** Exported for the tests that prove one person's tables have no spelling in
    another's SQL. */
export const appSqlOwner = ownerDigest;
export const appSqlMineTable = mineTable;
