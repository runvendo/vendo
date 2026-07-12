/**
 * DrizzleDecisionStore — durable port of the runtime `DecisionStore` seam
 * (packages/vendo-runtime/src/policy/remember.ts): memoised ask-once
 * approval decisions, keyed by an opaque canonical key and scoped per
 * Principal. Not a junk drawer — see the `decisions` table doc in schema.ts.
 */
import { and, eq } from "drizzle-orm";
import type { Principal } from "@vendoai/core";
import type { ApprovalDecision, DecisionStore } from "@vendoai/runtime";
import type { VendoDb } from "./db.js";
import { decisions } from "./schema.js";

/** `createDrizzleDecisionStore(handle, scope)` — one store per Principal,
 *  mirroring how `rememberDecisions` is wired per-request. */
export function createDrizzleDecisionStore(
  handle: VendoDb,
  scope: Principal,
  opts: { now?: () => string } = {},
): DecisionStore {
  const db = handle.db;
  const now = opts.now ?? (() => new Date().toISOString());

  return {
    async get(canonicalKey: string): Promise<ApprovalDecision | undefined> {
      const rows = await db
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.tenantId, scope.tenantId),
            eq(decisions.subject, scope.subject),
            eq(decisions.canonicalKey, canonicalKey),
          ),
        );
      const row = rows[0];
      return row ? (row.decision as ApprovalDecision) : undefined;
    },

    async set(canonicalKey: string, decision: ApprovalDecision): Promise<void> {
      await db
        .insert(decisions)
        .values({
          tenantId: scope.tenantId,
          subject: scope.subject,
          canonicalKey,
          decision,
          createdAt: now(),
        })
        .onConflictDoUpdate({
          target: [decisions.tenantId, decisions.subject, decisions.canonicalKey],
          set: { decision },
        });
    },
  };
}
