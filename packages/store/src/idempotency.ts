import { VendoError, type IdempotencyLedger, type Json } from "@vendoai/core";
// Type-only — erased at compile time, so this module stays engine-free and can
// be assembled into the store alongside the routing doors (see store.ts).
import type { Db } from "./db-postgres.js";
import { jsonParam, text } from "./helpers/utils.js";

/** 01 §12 — the `Idempotency-Key` replay ledger over `vendo_idempotency_ledger`,
 *  the table this same database carries (schema.ts v8). Colocated with the
 *  mutations it gates by construction: it runs on the handle the mutation runs
 *  on, so the two commit or roll back together. */
export function createIdempotencyLedger(db: Db): IdempotencyLedger {
  return {
    async check(scope, requestHash) {
      const result = await db.query(
        `SELECT request_hash, status, result FROM vendo_idempotency_ledger
         WHERE tenant = $1 AND op = $2 AND key = $3`,
        [scope.tenant, scope.op, scope.key],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      if (text(row["request_hash"]) !== requestHash) {
        throw new VendoError(
          "conflict",
          `idempotency key ${JSON.stringify(scope.key)} on ${scope.op} was already used for a `
          + "different request body, so there is no recorded answer that belongs to this one — "
          + "a key stands for ONE request. Mint a fresh key for a new request, and reuse a key "
          + "only to retry the identical body.",
        );
      }
      return { status: Number(row["status"]), result: row["result"] as Json };
    },
    async record(scope, requestHash, answer) {
      // First writer wins: the answer a replay has already been handed must not
      // change under it, so a later record for a held key is a no-op.
      await db.query(
        `INSERT INTO vendo_idempotency_ledger (tenant, op, key, request_hash, status, result)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (tenant, op, key) DO NOTHING`,
        [scope.tenant, scope.op, scope.key, requestHash, answer.status, jsonParam(answer.result)],
      );
    },
  };
}
