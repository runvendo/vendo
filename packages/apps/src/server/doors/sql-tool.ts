/**
 * `vendo_apps_sql` — the app's ONE reach into its own database, over the same
 * `requireOwned` gate every other door reads, with the single exception an app
 * that has no row yet forces (see `runAppSql`).
 *
 * The person is the LIVE caller: `subject` comes off the run context and never
 * off the tool args, so generated SQL has no field in which to name somebody
 * else — and no address either, which is the guard's half (app-sql-guard.ts).
 * That half is what the exception cannot touch: it holds whoever gets here.
 */
import {
  VendoError,
  type Json,
  type RunContext,
  type SqlDialect,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
} from "@vendoai/core";
import type { AppSqlAccess } from "../persistence/app-sql.js";
import type { AppDocument } from "../../contract/index.js";
import type { AppId } from "@vendoai/core";
import { input } from "./tool-args.js";

export const VENDO_APPS_SQL_TOOL = "vendo_apps_sql";

const DIALECT: Record<SqlDialect, string> = {
  postgres: "Postgres",
  sqlite: "SQLite",
};

/** The description carries the LIVE dialect, because SQL is written for one. */
export const appSqlDescriptor = (dialect: SqlDialect): ToolDescriptor => ({
  name: VENDO_APPS_SQL_TOOL,
  description:
    `Run one SQL statement against this app's own database (${DIALECT[dialect]}). `
    + "Every table lives in one of two namespaces and there is no third: `shared.<table>` is ONE table that all of "
    + "this app's users share, and `mine.<table>` is per-user — each person gets their own rows, and no statement "
    + "can reach anyone else's. Use mine. for whatever belongs to a person (their notes, their settings, their "
    + "orders) and shared. for what the app holds in common (a catalog, a leaderboard). A bare table name is "
    + "refused. One statement per call: SELECT, WITH, INSERT, UPDATE, DELETE, CREATE TABLE, ALTER TABLE or DROP "
    + "TABLE. Put every value that came from a person in `params` and write `?` where it goes — never paste it "
    + "into the SQL. Prefer SQL that reads the same on SQLite and Postgres (TEXT, INTEGER, REAL, PRIMARY KEY, "
    + "ordinary joins): an app can move between a host's own Postgres and a Vendo Cloud database, and the common "
    + "subset travels where a vendor-specific type or function does not.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      appId: {
        type: "string",
        minLength: 1,
        description: "The app whose database this is. Leave it out from inside the app — it is already known.",
      },
      sql: { type: "string", minLength: 1, description: "One SQL statement, with `?` where a parameter goes." },
      params: { type: "array", description: "One value per `?`, in order." },
    },
    required: ["sql"],
    additionalProperties: false,
  },
  // A SELECT is graded down to `read` per call by `AppsRuntime.agentToolRisk`,
  // which is what lets a running app's query take the query arm. The AUTHORED
  // grade is what a statement gets when nothing regrades it, so it is the
  // pessimistic one.
  risk: "write",
});

export interface AppSqlDependencies {
  sql?: AppSqlAccess;
  requireOwned(appId: AppId, ctx: RunContext): Promise<AppDocument>;
  /** Whether THIS caller's build is the one running for this id right now
   *  (`doors/placement-surface.ts`). Filled by the runtime that constructs the
   *  registry; see the ordering note in {@link runAppSql}. */
  buildingFor(appId: AppId, ctx: RunContext): boolean;
}

export const runAppSql = async (
  dependencies: AppSqlDependencies,
  call: ToolCall,
  ctx: RunContext,
): Promise<ToolOutcome> => {
  const { sql } = dependencies;
  if (sql === undefined) {
    throw new VendoError(
      "unavailable",
      "This deployment has no database for apps to keep data in. Pass a store to createVendo (its Postgres backs "
      + "every app), pass createVendo({ appDatabase }) yourself, or set VENDO_API_KEY for a Vendo Cloud database.",
    );
  }
  // `appId` is OPTIONAL from inside a running app: `ctx.appId` is stamped by the
  // platform when the app calls out (persistence/call.ts), so the app a screen
  // belongs to is never something the screen has to name — and never something it
  // can get wrong. An agent building one from outside that venue passes it.
  const args = input(call.args, ["sql"], ["appId", "params"]);
  const appId = (args.appId as string | undefined) ?? ctx.appId;
  if (appId === undefined) {
    throw new VendoError(
      "validation",
      "This call names no app, and it did not come from inside one. Pass appId — the id of the app whose database "
      + "you mean.",
    );
  }
  if (args.params !== undefined && !Array.isArray(args.params)) {
    throw new VendoError("validation", "params must be an array — one value per `?` in the statement, in order.");
  }
  // AN APP BEING BUILT HAS NO ROW TO OWN. A paint is what writes the app's row
  // (`checking/floor.ts` `delivered` → `authoredScreen`), and the paint is
  // gated by checks that RUN the screen's queries — so on the build that
  // CREATES an app, both the screen agent's own `CREATE TABLE` and the checks
  // floor's first-paint `SELECT` reach this line before any row exists, and
  // `requireOwned` answered `app not found` to every one of them. A capability
  // that cannot survive its own first build is not the receipt's item 4.
  //
  // The exemption is the narrowest true statement about that moment: an app
  // mid-mint has exactly one owner, the person whose build is minting it, and
  // `buildingFor` asks precisely that — this id, this subject, this process,
  // inside this assembler run. Anything else is untouched, so an id with no
  // build in flight is still existence-masked exactly as before and a row that
  // exists still decides for itself. Nothing here reaches the mine./shared.
  // boundary: `sql.run` scopes every `mine.` table to the caller's own subject
  // below, whichever branch got here.
  if (!dependencies.buildingFor(appId, ctx)) await dependencies.requireOwned(appId, ctx);
  const answer = await sql.run(
    appId,
    ctx.principal.subject,
    args.sql as string,
    args.params as readonly unknown[] | undefined,
  );
  return { status: "ok", output: answer as unknown as Json };
};
