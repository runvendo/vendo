import { z } from "zod";
import { grantDurationSchema, grantScopeSchema } from "./seams/grants";

/**
 * The consent channel (ENG-193 spec §4.5) — a Flowlet-owned request/response
 * pair riding BESIDE the ai SDK's native `{id, approved}` approval boolean,
 * which stays the resume trigger for gated tool calls (@flowlet/react,
 * `addToolApprovalResponse`, untouched). This channel carries everything the
 * boolean can't: tier/reason for card presentation, batch subset choices, and
 * an optional grant draft the server validates before minting a
 * `PermissionGrant` (`createGrantManager.create`, ENG-193 §4.3).
 *
 * v1-narrowed to `kind: "approval"` only (Yousef ruling, item-2 scope). The
 * discriminated union is the extension point: `"fade-proposal"` (§4.4) and
 * `"parked-action"` (§4.6) join it in later items. Do not widen this
 * speculatively — each new kind ships with its own consumer.
 */
export const consentRequestSchema = z
  .object({
    /** Correlates to `ConsentResponse.id`. In v1 this is the ai SDK `toolCallId`
     *  the request concerns — there is no separate server-minted consent id. */
    id: z.string(),
    kind: z.literal("approval"),
    tier: z.enum(["act", "critical"]),
    /** Plain-language reason (judge escalations, item 3). Reserved — empty/absent today. */
    reason: z.string().optional(),
    toolName: z.string(),
    /** Untruncated material fields — never the card's own truncated preview. */
    inputPreview: z.string(),
    batch: z.object({ id: z.string(), items: z.array(z.string()) }).optional(),
    stepUp: z.boolean().optional(),
  })
  .strict();
export type ConsentRequest = z.infer<typeof consentRequestSchema>;

/** A grant the server may mint if the response says yes — narrowed to what a
 *  human gesture can specify; the server derives `descriptorHash`/`source`
 *  (`handleConsent`, Task 4) — a client can never author those fields. */
export const consentGrantDraftSchema = z
  .object({
    tool: z.string(),
    scope: grantScopeSchema,
    duration: grantDurationSchema,
  })
  .strict();
export type ConsentGrantDraft = z.infer<typeof consentGrantDraftSchema>;

export const consentResponseSchema = z
  .object({
    id: z.string(),
    decision: z.enum(["yes", "no", "subset"]),
    /** toolCallIds included in a batch decision — informational context for
     *  audit even though each is independently confirmed by its own POST
     *  (`handleConsent` resolves one toolCallId per call, ENG-193 §4.5). */
    subset: z.array(z.string()).optional(),
    grant: consentGrantDraftSchema.optional(),
  })
  .strict();
export type ConsentResponse = z.infer<typeof consentResponseSchema>;
