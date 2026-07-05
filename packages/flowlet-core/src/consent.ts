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
 * A discriminated union on `kind`: `"approval"` is the original v1 chat-turn
 * shape; `"parked-action"` (ENG-193 §4.6) is the extension point this
 * docstring reserved, now populated. "fade-proposal" (§4.4) — see fade.ts for
 * its real accept/decline wire object. Do not widen this speculatively — each
 * new kind ships with its own consumer.
 */
const approvalConsentRequestSchema = z
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

/**
 * ENG-193 §4.6 — the "parked-action" extension point item 2's docstring
 * reserved, now populated. A parked action has no toolCallId/thread message
 * (it lives in the AutomationEngineStore, not a chat thread) — this is
 * narrower than the approval shape on purpose.
 */
const parkedActionConsentRequestSchema = z
  .object({
    id: z.string(), // the ParkedAction's own store-assigned id
    kind: z.literal("parked-action"),
    tier: z.enum(["act", "critical"]),
    toolName: z.string(),
    inputPreview: z.string(),
    reason: z.string().optional(), // "ungranted" | "critical", plain-language
  })
  .strict();

/**
 * ENG-193 §4.4 — the fade proposal card's own kind: "that's the third time
 * you've okayed this — want me to handle these without checking?" Like
 * `"parked-action"` before it, this is the documented extension point item
 * 2's docstring reserved — a contract-completeness addition; the actual
 * accept/decline wire object is `FadeProposalResolution` (see fade.ts), not
 * a `ConsentResponse` against this request.
 */
const fadeProposalConsentRequestSchema = z
  .object({
    /** The proposal's own id (FadeTracker-assigned, deterministic) — reused
     *  as this request's id; there is no separate toolCallId. */
    id: z.string(),
    kind: z.literal("fade-proposal"),
    tier: z.literal("act"),
    toolName: z.string(),
    /** Plain-language description of the narrowed shape, e.g. "reminder
     *  emails to your clients" — never "all email" (spec §3 Moment 5). */
    inputPreview: z.string(),
  })
  .strict();

export const consentRequestSchema = z.discriminatedUnion("kind", [
  approvalConsentRequestSchema,
  parkedActionConsentRequestSchema,
  fadeProposalConsentRequestSchema,
]);
export type ConsentRequest = z.infer<typeof consentRequestSchema>;

/**
 * The wire object POSTed to resolve a parked action (ENG-193 §4.6). Deliberately
 * NOT `ConsentResponse` — that shape is keyed by an ai SDK toolCallId against a
 * pending part inside a thread message; a parked action has neither (plan
 * deviation #1 — docs/superpowers/plans/2026-07-04-eng193-4-parking.md).
 */
export const parkedActionResolutionSchema = z
  .object({
    actionId: z.string(),
    decision: z.enum(["yes", "no"]),
  })
  .strict();
export type ParkedActionResolution = z.infer<typeof parkedActionResolutionSchema>;

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
