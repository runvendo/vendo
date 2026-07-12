import { z } from "zod";
import { appIdSchema, approvalIdSchema, type AppId, type ApprovalId } from "./ids.js";
import { riskLabelSchema, type RiskLabel } from "./tools.js";
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

/** 01-core §16 */
export interface VendoApprovalPart {
  type: "data-vendo-approval";
  toolCallId: string;
  risk: RiskLabel;
  approvalId?: ApprovalId;
}

/** 01-core §16 */
export const vendoApprovalPartSchema = z.object({
  type: z.literal("data-vendo-approval"),
  toolCallId: z.string(),
  risk: riskLabelSchema,
  approvalId: approvalIdSchema.optional(),
}).passthrough() satisfies z.ZodType<VendoApprovalPart>;
