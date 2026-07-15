import {
  VendoError,
  appIdSchema,
  isoDateTimeSchema,
  sha256Hex,
  type AppId,
  type IsoDateTime,
  type Pin,
} from "@vendoai/core";
import { z } from "zod";

/** 06-apps §8 — source captured from one host remixable component slot. */
export interface PinBaseline {
  slot: string;
  source: string;
  hash: string;
  exportable: boolean;
  capturedAt: IsoDateTime;
}

/** 06-apps §8 — validated persisted representation of a captured host baseline. */
export const pinBaselineSchema = z.object({
  slot: z.string(),
  source: z.string(),
  hash: z.string().startsWith("sha256:"),
  exportable: z.boolean(),
  capturedAt: isoDateTimeSchema,
}).passthrough() satisfies z.ZodType<PinBaseline>;

/** Internal stable generated-component name for one captured host slot. */
export const pinComponentName = (slot: string): string => {
  const stem = (slot.match(/[A-Za-z0-9]+/g) ?? [])
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("") || "Slot";
  // The hash suffix prevents punctuation-only normalization collisions while
  // keeping the name a valid generated-component PascalCase identifier.
  return `Pinned${stem}${sha256Hex(slot).slice(0, 8)}`;
};

/** 06-apps §8 — unified source diff proposed for host approval. */
export interface PinShipRequest {
  appId: AppId;
  slot: string;
  baseHash: string;
  diff: string;
}

/** 06-apps §8 — validated wire representation of a pin ship request. */
export const pinShipRequestSchema = z.object({
  appId: appIdSchema,
  slot: z.string(),
  baseHash: z.string(),
  diff: z.string(),
}).passthrough() satisfies z.ZodType<PinShipRequest>;

/** 06-apps §8 — immutable host approval for one baseline-to-version transition. */
export interface PinApproval {
  slot: string;
  baseHash: string;
  approvedHash: string;
  approvedBy: string;
  at: IsoDateTime;
}

/** 06-apps §8 — validated wire representation of a host pin approval. */
export const pinApprovalSchema = z.object({
  slot: z.string(),
  baseHash: z.string(),
  approvedHash: z.string(),
  approvedBy: z.string(),
  at: isoDateTimeSchema,
}).passthrough() satisfies z.ZodType<PinApproval>;

/** 06-apps §9 — approval to mount one exact app version in the host page. */
export interface InClientApproval {
  appId: AppId;
  versionHash: string;
  approvedBy: string;
  at: IsoDateTime;
}

/** 06-apps §9 — validated wire representation of an in-client approval. */
export const inClientApprovalSchema = z.object({
  appId: appIdSchema,
  versionHash: z.string(),
  approvedBy: z.string(),
  at: isoDateTimeSchema,
}).passthrough() satisfies z.ZodType<InClientApproval>;

/**
 * 06-apps §7–§8 — require explicit host permission for every exported pin.
 * Missing baselines fail closed because an artifact export must never strip pins.
 */
export const assertPinsExportable = (
  pins: readonly Pin[],
  baselines: readonly PinBaseline[],
): void => {
  for (const pin of pins) {
    const baseline = baselines.find((candidate) => candidate.slot === pin.slot);
    if (baseline?.hash === pin.base && baseline.exportable === true) continue;
    const reason = baseline === undefined
      ? "missing-baseline"
      : baseline.hash !== pin.base ? "baseline-hash-mismatch" : "baseline-forbids-export";
    throw new VendoError("blocked", `pin ${pin.slot} is not exportable`, {
      slot: pin.slot,
      base: pin.base,
      reason,
    });
  }
};
