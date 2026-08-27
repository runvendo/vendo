/**
 * One database per app. Real SQL, one adapter interface, two implementations
 * (the host's own Postgres in @vendoai/store, Vendo Cloud's per-app edge SQLite
 * in the umbrella) — the ADAPTER RULE seam for app storage.
 *
 * The adapter EXECUTES and decides nothing. Every rule that makes `mine.` one
 * user's rows and `shared.` everybody's — the guard, the physical names, the
 * per-owner schema replay — lives ABOVE this seam, in one place
 * (`@vendoai/apps`' app-sql), so the two implementations cannot disagree about
 * who can see what. An adapter that re-implemented the owner rule would be a
 * second copy of the security boundary, and two copies is how a boundary drifts.
 */

/** Which SQL the app's database speaks. Stated in the agent tool's own
    description, because generated SQL has to be written for it. */
export type SqlDialect = "postgres" | "sqlite";

/** One statement and its bound parameters. Parameters are `$1`-style on
    postgres and `?` on sqlite — the layer above spells them for the dialect it
    was handed. */
export interface SqlStatement {
  sql: string;
  params?: readonly unknown[];
}

/** What one statement answered. `columns` is empty and `rows` is empty for a
    statement that returns no rows; `rowCount` is how many rows the statement
    returned or affected. */
export interface SqlResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface AppDatabase {
  readonly dialect: SqlDialect;
  /**
   * Runs every statement, IN ORDER, inside ONE transaction against `appId`'s
   * own database, and answers with one result per statement. A throw rolls the
   * whole batch back — the caller relies on that: a schema replay and the
   * statement that needed it commit together or not at all.
   *
   * The batch is the whole contract. There is deliberately no interactive
   * transaction here: a Cloud app's database is an HTTP hop away, and holding
   * one open across round trips is the one thing an edge data plane cannot do.
   */
  run(appId: string, statements: readonly SqlStatement[]): Promise<SqlResult[]>;
  /** Every table `appId`'s database holds, by physical name. */
  tables(appId: string): Promise<string[]>;
  /** Destroys the app's database and everything in it. The erase cascade's leg. */
  drop(appId: string): Promise<void>;
}
