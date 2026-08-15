import { VendoError, type IdempotencyLedger, type IdempotencyRecord, type IdempotencyScope, type Json } from "@vendoai/core";
// Type-only — erased at compile time, so this module stays engine-free and can
// be assembled into the store alongside the routing doors (see store.ts).
import type { Db } from "./db-postgres.js";
import { jsonParam, text } from "./helpers/utils.js";

const PENDING_RESULT = {} as const;
const WAIT_INTERVAL_MS = 50;

const delay = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const hashConflict = (scope: IdempotencyScope): VendoError => new VendoError(
  "conflict",
  `idempotency key ${JSON.stringify(scope.key)} on ${scope.op} was already used for a `
  + "different request body, so there is no recorded answer that belongs to this one — "
  + "a key stands for ONE request. Mint a fresh key for a new request, and reuse a key "
  + "only to retry the identical body.",
);

const pendingTimeout = (scope: IdempotencyScope): VendoError => new VendoError(
  "unavailable",
  `idempotency key ${JSON.stringify(scope.key)} on ${scope.op} is still being processed; retry later`,
);

const published = (row: Record<string, unknown>): IdempotencyRecord | undefined => {
  if (row["claim_token"] !== null && row["claim_token"] !== undefined) return undefined;
  return { status: Number(row["status"]), result: row["result"] as Json };
};

/** 01 §12 — the `Idempotency-Key` replay ledger over `vendo_idempotency_ledger`,
 *  the table this same database carries (schema.ts v8). Colocated with the
 *  mutations it gates by construction: it runs on the handle the mutation runs
 *  on, so the two commit or roll back together. */
export function createIdempotencyLedger(
  db: Db,
  options: { waitTimeoutMs?: number } = {},
): IdempotencyLedger {
  const waitTimeoutMs = options.waitTimeoutMs ?? 30_000;
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs <= 0) {
    throw new VendoError("validation", "idempotency waitTimeoutMs must be positive");
  }

  const raceDeadline = async <T>(promise: Promise<T>, deadline: number): Promise<T | "expired"> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "expired";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<"expired">((resolve) => {
          timeout = setTimeout(() => resolve("expired"), remaining);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };

  const load = async (
    scope: IdempotencyScope,
    deadline: number,
  ): Promise<Record<string, unknown> | undefined> => {
    const query = db.query(
      `SELECT request_hash, status, result, claim_token FROM vendo_idempotency_ledger
       WHERE tenant = $1 AND op = $2 AND key = $3`,
      [scope.tenant, scope.op, scope.key],
    );
    const result = await raceDeadline(query, deadline);
    if (result === "expired") throw pendingTimeout(scope);
    return result.rows[0];
  };

  const assertHash = (row: Record<string, unknown>, scope: IdempotencyScope, requestHash: string): void => {
    if (text(row["request_hash"]) !== requestHash) throw hashConflict(scope);
  };

  const waitForAnswer = async (
    scope: IdempotencyScope,
    requestHash: string,
    first: Record<string, unknown>,
    deadline: number,
  ): Promise<IdempotencyRecord | null> => {
    let row = first;
    for (;;) {
      assertHash(row, scope, requestHash);
      const answer = published(row);
      if (answer !== undefined) return answer;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw pendingTimeout(scope);
      await delay(Math.min(WAIT_INTERVAL_MS, remaining));
      const loaded = await load(scope, deadline);
      if (loaded === undefined) return null;
      row = loaded;
    }
  };

  const cleanupTimedOutInsert = async (
    scope: IdempotencyScope,
    requestHash: string,
    claimToken: string,
  ): Promise<void> => {
    await db.query(
      `DELETE FROM vendo_idempotency_ledger
       WHERE tenant = $1 AND op = $2 AND key = $3
         AND request_hash = $4 AND claim_token = $5`,
      [scope.tenant, scope.op, scope.key, requestHash, claimToken],
    );
  };

  const boundedInsert = async (
    scope: IdempotencyScope,
    requestHash: string,
    claimToken: string,
    deadline: number,
  ): Promise<{ rows: Record<string, unknown>[] }> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw pendingTimeout(scope);
    const query = db.query(
      `WITH previous AS MATERIALIZED (
         SELECT current_setting('lock_timeout') AS lock_timeout
       ), configure AS MATERIALIZED (
         SELECT lock_timeout, set_config('lock_timeout', $7, true) FROM previous
       ), inserted AS (
         INSERT INTO vendo_idempotency_ledger
           (tenant, op, key, request_hash, status, result, claim_token)
         SELECT $1, $2, $3, $4, 503, $5::jsonb, $6 FROM configure
         ON CONFLICT (tenant, op, key) DO NOTHING
         RETURNING claim_token
       ), restore AS MATERIALIZED (
         SELECT set_config('lock_timeout', configure.lock_timeout, true)
         FROM configure LEFT JOIN inserted ON true
       )
       SELECT inserted.claim_token
       FROM restore LEFT JOIN inserted ON true`,
      [scope.tenant, scope.op, scope.key, requestHash, jsonParam(PENDING_RESULT), claimToken, String(remaining)],
    );
    const result = await raceDeadline(query, deadline);
    if (result !== "expired") return result;

    // PGlite queues behind an open transaction before the SQL statement can
    // install lock_timeout. If the queued INSERT eventually wins, remove its
    // reservation because this caller has already failed closed.
    void query.then(async (late) => {
      if (late.rows[0]?.["claim_token"] === claimToken) {
        await cleanupTimedOutInsert(scope, requestHash, claimToken);
      }
    }).catch(() => undefined);
    throw pendingTimeout(scope);
  };

  return {
    async check(scope, requestHash) {
      const deadline = Date.now() + waitTimeoutMs;
      const row = await load(scope, deadline);
      if (row === undefined) return null;
      return waitForAnswer(scope, requestHash, row, deadline);
    },
    async record(scope, requestHash, answer) {
      // First writer wins. ON CONFLICT DO UPDATE fills a reservation `claim`
      // left with a claim token; a later record against a published row is a
      // no-op. The request_hash predicate keeps a different body from
      // publishing over someone else's reservation.
      await db.query(
        `INSERT INTO vendo_idempotency_ledger (tenant, op, key, request_hash, status, result)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (tenant, op, key) DO UPDATE
         SET status = EXCLUDED.status, result = EXCLUDED.result, claim_token = NULL
         WHERE vendo_idempotency_ledger.claim_token IS NOT NULL
           AND vendo_idempotency_ledger.request_hash = EXCLUDED.request_hash`,
        [scope.tenant, scope.op, scope.key, requestHash, answer.status, jsonParam(answer.result)],
      );
    },
    async claim(scope, requestHash) {
      const deadline = Date.now() + waitTimeoutMs;
      for (;;) {
        let inserted: { rows: Record<string, unknown>[] };
        const claimToken = globalThis.crypto.randomUUID();
        try {
          inserted = await boundedInsert(scope, requestHash, claimToken, deadline);
        } catch (error) {
          if ((error as { code?: unknown }).code === "55P03") throw pendingTimeout(scope);
          throw error;
        }
        if (inserted.rows[0]?.["claim_token"] === claimToken) return "claimed";
        const row = await load(scope, deadline);
        if (row === undefined) continue;
        const answer = await waitForAnswer(scope, requestHash, row, deadline);
        if (answer !== null) return answer;
      }
    },
  };
}
