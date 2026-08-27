/**
 * The BYO rung of the app-database seam: each app gets its own fenced SCHEMA
 * inside the Postgres the host already wired, reached through the store handle
 * it already passed to `createVendo`. ZERO new configuration — a host that has
 * a store has app databases.
 *
 * This adapter EXECUTES and decides nothing. `mine.` and `shared.` are resolved
 * before a statement reaches it (@vendoai/apps' app-sql). The one thing it owns
 * is the FENCE the resolution rests on: every statement runs with `search_path`
 * set to this app's schema and nothing else, so a name that somehow arrived
 * unqualified resolves inside the app's own tables or nowhere at all — never in
 * the host's own drawers, and never in another app's.
 */
import { createHash } from "node:crypto";
import type { AppDatabase, SqlResult, SqlStatement } from "@vendoai/core";
import type { Query } from "./db-postgres.js";
import { maybeDbFor, type VendoStore } from "./store.js";

/** The app's schema. A readable slug for the operator looking at `\dn`, plus a
    digest so two app ids that sanitise alike can never share a schema. */
export const appSchema = (appId: string): string =>
  `vendo_app_${appId.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32)}`
  + `_${createHash("sha256").update(appId).digest("hex").slice(0, 12)}`;

const shape = (result: { rows: Record<string, unknown>[]; rowCount?: number }): SqlResult => ({
  columns: Object.keys(result.rows[0] ?? {}),
  rows: result.rows,
  rowCount: result.rowCount ?? result.rows.length,
});

/** ADAPTER RULE, app-database seam: the implementation for a store this package
 *  minted. `undefined` for a handle with no SQL behind it (a hosted store, or a
 *  host's own adapter) — the composition seam then picks another rung. */
export function postgresAppDatabase(store: VendoStore): AppDatabase | undefined {
  const db = maybeDbFor(store);
  if (db === undefined) return undefined;
  const fenced = new Set<string>();

  const inSchema = async <T>(appId: string, work: (query: Query, schema: string) => Promise<T>): Promise<T> => {
    const schema = appSchema(appId);
    const result = await db.transaction(async (query) => {
      if (!fenced.has(schema)) await query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      // The fence. Not a convenience: it is why an unqualified name cannot name
      // anything outside this app. pg_catalog stays implicitly searchable so
      // built-in functions resolve; the guard refuses every `pg_` identifier.
      await query(`SET LOCAL search_path = "${schema}"`);
      return await work(query, schema);
    });
    fenced.add(schema);
    return result;
  };

  return {
    dialect: "postgres",
    run: (appId, statements: readonly SqlStatement[]) => inSchema(appId, async (query) => {
      const answers: SqlResult[] = [];
      for (const statement of statements) {
        answers.push(shape(await query(statement.sql, [...(statement.params ?? [])])));
      }
      return answers;
    }),
    tables: (appId) => inSchema(appId, async (query, schema) => {
      const { rows } = await query("SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename", [schema]);
      return rows.map((row) => String(row["tablename"]));
    }),
    async drop(appId) {
      const schema = appSchema(appId);
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      fenced.delete(schema);
    },
  };
}
