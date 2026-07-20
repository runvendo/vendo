import { z } from "zod";
import { appIdSchema, approvalIdSchema, type AppId, type ApprovalId } from "./ids.js";

/**
 * Existing-agents contract — the versioned tool-output envelopes a BYO agent
 * loop receives from the Vendo tool pack (same `kind: "vendo/<name>@1"`
 * pattern as the MCP door's `vendo/open-in-product@1` card). A `vendo_*` tool
 * returns either one of these small JSON refs — which the host's chat renders
 * with the matching embed component — or plain data, meaning the action
 * executed cleanly and the agent consumes the result like any tool output.
 * Frozen in `docs/superpowers/specs/2026-07-20-existing-agents-contracts.md`.
 */
export const VENDO_APP_REF_KIND = "vendo/app-ref@1" as const;
export const VENDO_APPROVAL_REF_KIND = "vendo/approval-ref@1" as const;

/** `vendo_create_app` returned fast: the app exists and its build streams over
 *  the wire. `<VendoAppEmbed>` mounts the app by this ref. */
export interface VendoAppRef {
  kind: typeof VENDO_APP_REF_KIND;
  appId: AppId;
  /** Display title for the embed's chrome while the build streams. */
  title: string;
}

/** A guarded call parked on approval: the model sees "pending — the user must
 *  approve in the UI"; `<VendoApprovalEmbed>` resolves it in place. */
export interface VendoApprovalRef {
  kind: typeof VENDO_APPROVAL_REF_KIND;
  approvalId: ApprovalId;
  /** Human-readable line for the model and the embed: what is waiting. */
  summary: string;
}

export type VendoToolEnvelope = VendoAppRef | VendoApprovalRef;

/** Readers tolerate unknown extra fields — additive evolution stays within @1;
 *  anything breaking bumps the kind. */
export const vendoAppRefSchema = z.object({
  kind: z.literal(VENDO_APP_REF_KIND),
  appId: appIdSchema,
  title: z.string(),
}).passthrough() satisfies z.ZodType<VendoAppRef>;

export const vendoApprovalRefSchema = z.object({
  kind: z.literal(VENDO_APPROVAL_REF_KIND),
  approvalId: approvalIdSchema,
  summary: z.string().min(1),
}).passthrough() satisfies z.ZodType<VendoApprovalRef>;

export const vendoToolEnvelopeSchema = z.discriminatedUnion("kind", [
  vendoAppRefSchema,
  vendoApprovalRefSchema,
]) satisfies z.ZodType<VendoToolEnvelope>;

/** The `<VendoToolResult>` dispatch: give it any `vendo_*` tool output and get
 *  the typed envelope to render, or null for plain data (and for a malformed
 *  envelope — the tool pack is the only writer, so a bad shape is a bug there,
 *  not something for a foreign chat surface to half-render). */
export function parseVendoToolEnvelope(output: unknown): VendoToolEnvelope | null {
  const parsed = vendoToolEnvelopeSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}
