import { z } from "zod";
import {
  appIdSchema,
  approvalIdSchema,
  grantIdSchema,
  isoDateTimeSchema,
  type AppId,
  type ApprovalId,
  type GrantId,
  type IsoDateTime,
} from "./ids.js";
import { riskLabelSchema, type RiskLabel } from "./tools.js";
import type { ToolCall } from "./tools.js";
import { uiPayloadSchema, type UIPayload } from "./tree.js";

/** 01-core §16 */
export interface VendoViewPart {
  type: "data-vendo-view";
  appId: AppId;
  payload: UIPayload;
}

/** 01-core §16 */
export const vendoViewPartSchema = z.object({
  type: z.literal("data-vendo-view"),
  appId: appIdSchema,
  payload: uiPayloadSchema,
}).passthrough() satisfies z.ZodType<VendoViewPart>;

/** AGENT-10 (wave 5, additive — 01 §16 amendment parked): the ai-SDK envelope
 *  the wire and persisted UIMessages ACTUALLY carry. The flat §16 interfaces
 *  above are the logical parts; on the wire the ai-SDK data-chunk schema
 *  requires the payload nested under `data`, with an optional reconciliation
 *  `id`. Producers convert with {@link toVendoWirePart}; consumers parse with
 *  the *WirePartSchema pairings below. */
export interface VendoWirePart<Part extends { type: string }> {
  type: Part["type"];
  data: Omit<Part, "type">;
  /** Stable ai-SDK data-part id so successive writes reconcile in place. */
  id?: string;
}

export type VendoViewWirePart = VendoWirePart<VendoViewPart>;
export type VendoApprovalWirePart = VendoWirePart<VendoApprovalPart>;
export type VendoConnectWirePart = VendoWirePart<VendoConnectPart>;

/** Nest a flat §16 part into its wire envelope ({ type, ...rest } → { type, data: rest }). */
export function toVendoWirePart<Part extends { type: string }>(
  part: Part,
  id?: string,
): VendoWirePart<Part> {
  const { type, ...data } = part;
  return { type, data, ...(id === undefined ? {} : { id }) } as VendoWirePart<Part>;
}

const wirePartSchema = <Type extends string, Data extends z.ZodRawShape>(
  type: Type,
  data: z.ZodObject<Data>,
) => z.object({
  type: z.literal(type),
  data: data.passthrough(),
  id: z.string().optional(),
}).passthrough();

/** Additive internal bridge seam: one tool execution can publish view updates. */
export const VENDO_VIEW_STREAM = Symbol.for("@vendoai/core/vendo-view-stream");

export interface VendoViewStreamUpdate {
  id: string;
  part: VendoViewPart;
}

export type VendoViewStreamingToolCall = ToolCall & {
  [VENDO_VIEW_STREAM]?: (update: VendoViewStreamUpdate) => void;
};

/** Stable ai-SDK data-part id so partial and final views reconcile in place. */
export const vendoViewStreamId = (appId: AppId): string => `vendo-view:${appId}`;

/** 01-core §16 — the inline connect-card part: emitted beside the native tool
 * part when a connector call ends `connect-required` (04-actions §3), keyed by
 * `toolCallId` exactly like the approval part. */
export interface VendoConnectPart {
  type: "data-vendo-connect";
  toolCallId: string;
  connector: string;
  toolkit: string;
  message: string;
}

/** 01-core §16 */
export const vendoConnectPartSchema = z.object({
  type: z.literal("data-vendo-connect"),
  toolCallId: z.string(),
  connector: z.string().min(1),
  toolkit: z.string().min(1),
  message: z.string(),
}).passthrough() satisfies z.ZodType<VendoConnectPart>;

/** 01-core §16 */
export interface VendoApprovalPart {
  type: "data-vendo-approval";
  toolCallId: string;
  risk: RiskLabel;
  approvalId?: ApprovalId;
  invalidatedGrant?: {
    id: GrantId;
    grantedAt: IsoDateTime;
  };
}

/** 01-core §16 */
export const vendoApprovalPartSchema = z.object({
  type: z.literal("data-vendo-approval"),
  toolCallId: z.string(),
  risk: riskLabelSchema,
  approvalId: approvalIdSchema.optional(),
  invalidatedGrant: z.object({
    id: grantIdSchema,
    grantedAt: isoDateTimeSchema,
  }).passthrough().optional(),
}).passthrough() satisfies z.ZodType<VendoApprovalPart>;

/** AGENT-7 (wave 5, additive — 01 §16 amendment parked): streamed when the
 *  agent loop stops because it exhausted its step cap, so the exhaustion is
 *  visible to the client instead of the turn just ending mid-plan. Consumers
 *  that don't recognize it ignore it (§15 forward-compat). */
export interface VendoStepLimitPart {
  type: "data-vendo-step-limit";
  /** The step cap the run exhausted. */
  limit: number;
  /** A renderable, provider-safe explanation. */
  message: string;
}

/** AGENT-7 */
export const vendoStepLimitPartSchema = z.object({
  type: z.literal("data-vendo-step-limit"),
  limit: z.number().int().positive(),
  message: z.string(),
}).passthrough() satisfies z.ZodType<VendoStepLimitPart>;

/** AGENT-10 — the nested wire envelope of {@link vendoViewPartSchema}. */
export const vendoViewWirePartSchema = wirePartSchema(
  "data-vendo-view",
  vendoViewPartSchema.omit({ type: true }),
) satisfies z.ZodType<VendoViewWirePart>;
