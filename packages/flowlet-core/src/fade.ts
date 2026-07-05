import { z } from "zod";

/**
 * A fade proposal's derived scope shape (ENG-193 spec §4.4). Computed
 * server-side by `deriveFadeShape` (@flowlet/runtime's `policy/fade-shapes.ts`)
 * and carried in `fadeEligible` (the runtime `handleConsent`'s result) so the
 * client can render a bit of context without re-deriving anything — the
 * client never derives or supplies a shape, only ever echoes a `proposalId`.
 * Intentionally the SAME leaf as `GrantConstraint` minus the array wrapper: a
 * fade always narrows on ONE field or falls back to the whole tool.
 */
export const fadeShapeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool") }).strict(),
  z
    .object({
      kind: z.literal("constrained"),
      path: z.string().min(1),
      op: z.enum(["eq", "matches"]),
      value: z.union([z.string(), z.number(), z.boolean()]),
    })
    .strict(),
]);
export type FadeShape = z.infer<typeof fadeShapeSchema>;

/**
 * The wire object POSTed to accept/decline a fade proposal (ENG-193 §4.4/§4.5).
 * Deliberately NOT `ConsentResponse` — a fade proposal is keyed by its own
 * `proposalId`, not an ai SDK toolCallId against a pending thread part (same
 * reasoning as `ParkedActionResolution`, see consent.ts).
 */
export const fadeProposalResolutionSchema = z
  .object({
    proposalId: z.string(),
    accept: z.boolean(),
  })
  .strict();
export type FadeProposalResolution = z.infer<typeof fadeProposalResolutionSchema>;
