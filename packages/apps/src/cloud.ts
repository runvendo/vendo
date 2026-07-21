import {
  appDocumentSchema,
  appIdSchema,
  isoDateTimeSchema,
  type AppDocument,
  type AppId,
  type IsoDateTime,
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

/** ADAPTER RULE (see selectConnections in the umbrella's server.ts): the apps
 * block defines the share/publish seam; which implementation composes is
 * decided at the createVendo composition seam — never by a key-conditional
 * inside this block, which reads no environment. The umbrella wires the Cloud
 * console client here when VENDO_API_KEY fills the unset slot; an unfilled
 * seam fails honestly with VendoError("cloud-required"). */
export interface CloudAppsClient {
  share(appId: AppId, doc: AppDocument): Promise<ShareSnapshot>;
  publish(appId: AppId, doc: AppDocument): Promise<PublishRecord>;
}
