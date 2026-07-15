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
