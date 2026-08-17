import { z } from "zod";
import type { AutomationId } from "./automation.js";
import { appIdSchema, approvalIdSchema, isoDateTimeSchema, type AppId, type ApprovalId, type IsoDateTime } from "./ids.js";

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
export const VENDO_AUTOMATION_REF_KIND = "vendo/automation-ref@1" as const;

/** `vendo_make` returned fast: the build was ACCEPTED and is still
 *  streaming over the wire — the app is NOT built yet. `<VendoAppEmbed>` mounts
 *  it by this ref and shows live build progress, the finished app, or the build
 *  failure itself, so the model must not claim the app is created/ready/done.
 *  `status` is always `"building"` — a MACHINE-readable field, not prose, so a
 *  model that skims past the tool description still cannot mistake this for a
 *  finished, describable resource: given an envelope carrying only an appId and
 *  a title, observed conversations narrated a fabricated, finished dashboard.
 *  A build that terminally fails is never wrapped in this ref —
 *  see `appRefFromReceipt` in `@vendoai/harnesses`. */
export interface VendoAppRef {
  kind: typeof VENDO_APP_REF_KIND;
  appId: AppId;
  /** Display title for the embed's chrome while the build streams. */
  title: string;
  /** Always "building": this envelope never means done, win or lose. */
  status: "building";
}

/** A guarded call parked on approval: the model sees "pending — the user must
 *  approve in the UI"; `<VendoApprovalEmbed>` resolves it in place. */
export interface VendoApprovalRef {
  kind: typeof VENDO_APPROVAL_REF_KIND;
  approvalId: ApprovalId;
  /** Human-readable line for the model and the embed: what is waiting. */
  summary: string;
}

/** What `vendo_automate` returns: the record it just armed, in one line the
 *  model and the embed both read. */
export interface VendoAutomationRef {
  kind: typeof VENDO_AUTOMATION_REF_KIND;
  automationId: AutomationId;
  summary: string;
  armed: boolean;
  /** Computed on read from `when` — never a stored column, and absent for
   *  event/webhook records, which have no next run. */
  nextRunAt?: IsoDateTime;
}

export type VendoToolEnvelope = VendoAppRef | VendoApprovalRef | VendoAutomationRef;

/** Readers tolerate unknown extra fields — additive evolution stays within @1;
 *  anything breaking bumps the kind. */
export const vendoAppRefSchema = z.object({
  kind: z.literal(VENDO_APP_REF_KIND),
  appId: appIdSchema,
  title: z.string(),
  status: z.literal("building"),
}).passthrough() satisfies z.ZodType<VendoAppRef>;

export const vendoApprovalRefSchema = z.object({
  kind: z.literal(VENDO_APPROVAL_REF_KIND),
  approvalId: approvalIdSchema,
  summary: z.string().min(1),
}).passthrough() satisfies z.ZodType<VendoApprovalRef>;

export const vendoAutomationRefSchema = z.object({
  kind: z.literal(VENDO_AUTOMATION_REF_KIND),
  automationId: z.string().min(1),
  summary: z.string().min(1),
  armed: z.boolean(),
  nextRunAt: isoDateTimeSchema.optional(),
}).passthrough() satisfies z.ZodType<VendoAutomationRef>;

export const vendoToolEnvelopeSchema = z.discriminatedUnion("kind", [
  vendoAppRefSchema,
  vendoApprovalRefSchema,
  vendoAutomationRefSchema,
]) satisfies z.ZodType<VendoToolEnvelope>;

/** The `<VendoToolResult>` dispatch: give it any `vendo_*` tool output and get
 *  the typed envelope to render, or null for plain data (and for a malformed
 *  envelope — the tool pack is the only writer, so a bad shape is a bug there,
 *  not something for a foreign chat surface to half-render). */
export function parseVendoToolEnvelope(output: unknown): VendoToolEnvelope | null {
  const parsed = vendoToolEnvelopeSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}
