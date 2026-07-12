import { appIdSchema, isoDateTimeSchema, type AppId, type IsoDateTime } from "@vendoai/core";
import { z } from "zod";

/** 06-apps §8 */
export interface PinBaseline {
  slot: string;
  source: string;
  hash: string;
  exportable: boolean;
  capturedAt: IsoDateTime;
}

/** 06-apps §8 */
export const pinBaselineSchema = z.object({
  slot: z.string(),
  source: z.string(),
  hash: z.string(),
  exportable: z.boolean(),
  capturedAt: isoDateTimeSchema,
}).passthrough() satisfies z.ZodType<PinBaseline>;

/** 06-apps §8 */
export interface PinShipRequest {
  appId: AppId;
  slot: string;
  baseHash: string;
  diff: string;
}

/** 06-apps §8 */
export const pinShipRequestSchema = z.object({
  appId: appIdSchema,
  slot: z.string(),
  baseHash: z.string(),
  diff: z.string(),
}).passthrough() satisfies z.ZodType<PinShipRequest>;

/** 06-apps §8 */
export interface PinApproval {
  slot: string;
  baseHash: string;
  approvedHash: string;
  approvedBy: string;
  at: IsoDateTime;
}

/** 06-apps §8 */
export const pinApprovalSchema = z.object({
  slot: z.string(),
  baseHash: z.string(),
  approvedHash: z.string(),
  approvedBy: z.string(),
  at: isoDateTimeSchema,
}).passthrough() satisfies z.ZodType<PinApproval>;

/** 06-apps §9 */
export interface InClientApproval {
  appId: AppId;
  versionHash: string;
  approvedBy: string;
  at: IsoDateTime;
}

/** 06-apps §9 */
export const inClientApprovalSchema = z.object({
  appId: appIdSchema,
  versionHash: z.string(),
  approvedBy: z.string(),
  at: isoDateTimeSchema,
}).passthrough() satisfies z.ZodType<InClientApproval>;
