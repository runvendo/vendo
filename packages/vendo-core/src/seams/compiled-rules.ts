import { z } from "zod";
import type { Principal } from "./principal";
import { grantConstraintSchema } from "./grants";

/**
 * CompiledRule — the deterministic artifact behind conversational steering's
 * TIGHTEN half (ENG-193 spec §3 Moment 11, §4.8, §2 principle 7). "Always ask
 * before X" compiles to one of these; the runtime's `compiledRulesPolicy`
 * matches it structurally against every subsequent call — never NL -> vibes
 * at ENFORCEMENT time, only at COMPILE time (the model only ever gets to
 * choose the rule's shape once, when the tool is called).
 *
 * v1 ships exactly ONE kind, "always_ask" (tighten only — item-6 scope
 * ruling #3: "Rules can only tighten in v1 (no deny rules yet ... document
 * deny as v2)"). A future "deny" kind (silently refuse rather than escalate)
 * would need to reconcile a THIRD outcome against deny/grant/judge
 * precedence in `compiledRulesPolicy` — deliberately out of scope here.
 */
export const compiledRuleSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    subject: z.string(),
    kind: z.literal("always_ask"),
    /** Exact tool name or a glob (`*`) — matched with the SAME glob helper
     *  grant constraints use (`policy/grant-match.ts`'s `globMatches`). A
     *  pattern with no `*` degenerates to an exact match (item-6 deviation
     *  #7) — this one field covers both "toolName" and "toolPattern". */
    toolPattern: z.string().min(1),
    /** Narrows the rule to calls whose input ALSO matches (reuses the grant
     *  constraint shape — same predicate semantics, same fail-closed rule:
     *  a missing field never matches). */
    constraint: grantConstraintSchema.optional(),
    /** The compiled confirmation copy the user actually said/agreed to,
     *  e.g. "emailing anyone at Acme" — voiced back verbatim (Moment 11's
     *  "Got it") and shown on the Trust screen's Rules row. */
    plainText: z.string().min(1),
    createdAt: z.string(),
    revokedAt: z.string().optional(),
  })
  .strict();
export type CompiledRule = z.infer<typeof compiledRuleSchema>;

/**
 * CompiledRuleStore seam. Mirrors `GrantStore`'s shape (store-assigned
 * identity, Principal-scoped, soft-revoke) with ONE deliberate omission: no
 * `findForTool`. A grant's `tool` is a single canonical name, so an exact
 * pre-filter by tool name is sound; a rule's `toolPattern` is a GLOB that may
 * match names it was never keyed under, so `compiledRulesPolicy` fetches
 * `list()` and matches every live rule structurally instead of relying on a
 * store-side pre-filter that could silently miss a glob match.
 */
export interface CompiledRuleStore {
  create(
    scope: Principal,
    rule: Omit<CompiledRule, "id" | "tenantId" | "subject" | "createdAt" | "revokedAt">,
  ): Promise<CompiledRule>;
  list(scope: Principal): Promise<CompiledRule[]>;
  revoke(scope: Principal, id: string): Promise<void>;
}
