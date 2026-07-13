import {
  VendoError,
  appDocumentSchema,
  appIdSchema,
  isoDateTimeSchema,
  type AppDocument,
  type AppId,
  type IsoDateTime,
  type RunContext,
  type VendoErrorCode,
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

const cloudBaseUrl = (): string => {
  const configured = globalThis.process?.env?.VENDO_CLOUD_URL;
  return (configured === undefined || configured === ""
    ? "https://console.vendo.run"
    : configured).replace(/\/+$/, "");
};

const CLOUD_ERROR_CODES = new Set<VendoErrorCode>([
  "validation",
  "not-found",
  "conflict",
  "blocked",
  "cloud-required",
]);

const errorEnvelope = async (
  response: Response,
): Promise<{ code: string; message: string }> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    parsed = undefined;
  }
  const error = typeof parsed === "object" && parsed !== null && "error" in parsed
    ? (parsed as { error?: unknown }).error
    : undefined;
  return {
    code: typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "unknown",
    message: typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : response.statusText || `HTTP ${response.status}`,
  };
};

const throwCloudError = async (response: Response): Promise<never> => {
  const error = await errorEnvelope(response);
  if (response.status === 402) {
    throw new VendoError("cloud-required", error.message);
  }
  if (CLOUD_ERROR_CODES.has(error.code as VendoErrorCode)) {
    throw new VendoError(error.code as VendoErrorCode, error.message);
  }
  throw Object.assign(new Error(error.message), { code: error.code });
};

const request = async <T>(
  path: "/api/v1/apps/share" | "/api/v1/apps/publish",
  appId: AppId,
  doc: AppDocument,
  schema: z.ZodType<T>,
): Promise<T> => {
  const key = cloudKey();
  if (key === undefined || key === "") {
    throw new VendoError("cloud-required", "Vendo Cloud requires VENDO_API_KEY");
  }
  const response = await fetch(`${cloudBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ appId, doc }),
  });
  if (!response.ok) await throwCloudError(response);
  return schema.parse(await response.json());
};

/** 06-apps §1 — create a frozen copy through Vendo Cloud. */
export const share = async (
  appId: AppId,
  doc: AppDocument,
  _ctx: RunContext,
): Promise<ShareSnapshot> => request("/api/v1/apps/share", appId, doc, shareSnapshotSchema);

/** 06-apps §1 — publish an app copy through Vendo Cloud. */
export const publish = async (
  appId: AppId,
  doc: AppDocument,
  _ctx: RunContext,
): Promise<PublishRecord> => request("/api/v1/apps/publish", appId, doc, publishRecordSchema);
