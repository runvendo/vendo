import {
  VendoError,
  appDocumentSchema,
  appIdSchema,
  isoDateTimeSchema,
  type AppDocument,
  type AppId,
  type IsoDateTime,
  type RunContext,
} from "@vendoai/core";
import { z } from "zod";

/** 06-apps §1 — frozen copy created by Vendo Cloud sharing. */
export interface ShareSnapshot {
  id: string;
  doc: AppDocument;
  createdAt: IsoDateTime;
}

/** 06-apps §1 — validated wire representation of a frozen share copy. */
export const shareSnapshotSchema = z.object({
  id: z.string(),
  doc: appDocumentSchema,
  createdAt: isoDateTimeSchema,
}).passthrough() satisfies z.ZodType<ShareSnapshot>;

/** 06-apps §1 — registry record for a published app copy. */
export interface PublishRecord {
  id: string;
  appId: AppId;
  version: string;
  createdAt: IsoDateTime;
}

/** 06-apps §1 — validated wire representation of a publish record. */
export const publishRecordSchema = z.object({
  id: z.string(),
  appId: appIdSchema,
  version: z.string(),
  createdAt: isoDateTimeSchema,
}).passthrough() satisfies z.ZodType<PublishRecord>;

const cloudKey = (): string | undefined => (
  globalThis.process?.env?.VENDO_API_KEY
);

const unavailable = (): never => {
  if (cloudKey() === undefined || cloudKey() === "") {
    throw new VendoError("cloud-required", "Vendo Cloud requires VENDO_API_KEY");
  }
  throw new VendoError("not-implemented", "Vendo Cloud client ships separately in v0");
};

/** 06-apps §1 and block-plan decision 6 — Cloud share client placeholder. */
export const share = async (
  _appId: AppId,
  _ctx: RunContext,
): Promise<ShareSnapshot> => unavailable();

/** 06-apps §1 and block-plan decision 6 — Cloud publish client placeholder. */
export const publish = async (
  _appId: AppId,
  _ctx: RunContext,
): Promise<PublishRecord> => unavailable();
