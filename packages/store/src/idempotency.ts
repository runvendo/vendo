import { VendoError, type IdempotencyLedger, type IdempotencyScope, type Json } from "@vendoai/core";
// Type-only — erased at compile time, so this module stays engine-free and can
// be assembled into the store alongside the routing doors (see store.ts).
import type { Db } from "./db-postgres.js";
import { jsonParam, text } from "./helpers/utils.js";

/** A reservation `claim` took but nobody has answered yet, spelled in the
 *  `status` column the table already carries (schema.ts v8) so reserving costs
 *  no migration and no nullable answer. 0 is not a status any mount can send —
 *  `IdempotencyRecord.status` is "the HTTP status the mount sent" — so a
 *  reservation can never be mistaken for an answer, and an older reader that
 *  predates `claim` cannot mistake one for a replayable result either. */
const RESERVED = 0;

const conflictFor = (scope: IdempotencyScope): VendoError =>
  new VendoError(
    "conflict",
    `idempotency key ${JSON.stringify(scope.key)} on ${scope.op} was already used for a `
    + "different request body, so there is no recorded answer that belongs to this one — "
    + "a key stands for ONE request. Mint a fresh key for a new request, and reuse a key "
    + "only to retry the identical body.",
  );

/** 01 §12 — the `Idempotency-Key` replay ledger over `vendo_idempotency_ledger`,
 *  the table this same database carries (schema.ts v8). Colocated with the
 *  mutations it gates by construction: it runs on the handle the mutation runs
 *  on, so the two commit or roll back together. */
export function createIdempotencyLedger(db: Db): IdempotencyLedger {
  const readRow = async (scope: IdempotencyScope): Promise<Record<string, unknown> | undefined> => {
    const result = await db.query(
      `SELECT request_hash, status, result FROM vendo_idempotency_ledger
       WHERE tenant = $1 AND op = $2 AND key = $3`,
      [scope.tenant, scope.op, scope.key],
    );
    return result.rows[0];
  };

  /** What a held row answers THIS request: its recorded answer, or null when the
      row is only a reservation. A differing hash is not an answer at all — it is
      another request's row — so it refuses rather than replaying someone else's
      result. Shared by `check` and `claim` so the two can never drift on what a
      reservation means, which is the divergence that reopens the race. */
  const answerFor = (
    row: Record<string, unknown>,
    scope: IdempotencyScope,
    requestHash: string,
  ): { status: number; result: Json } | null => {
    if (text(row["request_hash"]) !== requestHash) throw conflictFor(scope);
    const status = Number(row["status"]);
    if (status === RESERVED) return null;
    return { status, result: row["result"] as Json };
  };

  return {
    async claim(scope, requestHash) {
      // The reservation IS the test: one statement against the (tenant, op, key)
      // primary key, so of two racers exactly one gets a row back and the loser
      // reads what the winner reserved. A SELECT-then-INSERT here would be the
      // very check-then-do shape `claim` exists to replace.
      //
      // Bounded loop for the one gap a single statement leaves: the row can be
      // gone by the read-back, and the retry re-reserves the now-free key rather
      // than degrading that key to check-then-do for good. Nothing in this repo
      // produces that today — no erase selector reaches this table, which is the
      // never-matched class erase.ts calls out — so two passes is the whole
      // budget; a key being deleted in a loop is not worth spinning on.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const reserved = await db.query(
          `INSERT INTO vendo_idempotency_ledger (tenant, op, key, request_hash, status, result)
           VALUES ($1, $2, $3, $4, ${RESERVED}, 'null'::jsonb)
           ON CONFLICT (tenant, op, key) DO NOTHING
           RETURNING key`,
          [scope.tenant, scope.op, scope.key, requestHash],
        );
        if (reserved.rows.length > 0) return "claimed";
        const row = await readRow(scope);
        if (row === undefined) continue;
        return answerFor(row, scope, requestHash);
      }
      // Never "claimed": telling a caller it owns a key it holds no row for is
      // the one answer that licenses the mutation this verb is meant to gate.
      // null degrades to exactly what `check` would have said — go do the work.
      return null;
    },
    async check(scope, requestHash) {
      const row = await readRow(scope);
      if (row === undefined) return null;
      return answerFor(row, scope, requestHash);
    },
    async record(scope, requestHash, answer) {
      // First ANSWER wins: the answer a replay has already been handed must not
      // change under it, so the UPDATE is gated on the row still being a
      // reservation. `request_hash` is gated too, so a reservation is settled
      // only by the request that took it. A different body reaches here on the
      // `check` fallback — where the key can be taken between the check and the
      // record — and it leaves the owner's reservation standing rather than
      // stamping its own answer onto a key it never held.
      await db.query(
        `INSERT INTO vendo_idempotency_ledger (tenant, op, key, request_hash, status, result)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (tenant, op, key) DO UPDATE
           SET status = EXCLUDED.status, result = EXCLUDED.result
           WHERE vendo_idempotency_ledger.status = ${RESERVED}
             AND vendo_idempotency_ledger.request_hash = EXCLUDED.request_hash`,
        [scope.tenant, scope.op, scope.key, requestHash, answer.status, jsonParam(answer.result)],
      );
    },
  };
}
