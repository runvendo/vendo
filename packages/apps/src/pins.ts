import {
  VendoError,
  appIdSchema,
  isoDateTimeSchema,
  sha256Hex,
  type AppDocument,
  type AppId,
  type IsoDateTime,
  type Json,
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
  sourceImports?: Record<string, string>;
  subSources?: Record<string, PinSubSource>;
  sampleProps?: Record<string, Json>;
  styles?: PinStyle[];
}

/** Captured source-owned virtual module plus its own resolved import table. */
export interface PinSubSource {
  source: string;
  imports: Record<string, string>;
}

/** One inert host stylesheet snapshot captured from a canonical app root. */
export interface PinStyle {
  path: string;
  css: string;
}

const pinSubSourceSchema = z.object({
  source: z.string(),
  imports: z.record(z.string()),
}).passthrough() satisfies z.ZodType<PinSubSource>;

const pinStyleSchema = z.object({
  path: z.string(),
  css: z.string(),
}).passthrough() satisfies z.ZodType<PinStyle>;

/** 06-apps §8 — validated persisted representation of a captured host baseline. */
export const pinBaselineSchema = z.object({
  slot: z.string(),
  source: z.string(),
  hash: z.string().startsWith("sha256:"),
  exportable: z.boolean(),
  capturedAt: isoDateTimeSchema,
  sourceImports: z.record(z.string()).optional(),
  subSources: z.record(pinSubSourceSchema).optional(),
  sampleProps: z.record(z.unknown()).optional(),
  styles: z.array(pinStyleSchema).optional(),
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

const EXPORT_LIST = /\bexport\s*\{([^}]*)\}/gu;

/** Whether the fork entry source exposes the default export the jail renders:
    `export default …`, `export { X as default }`, or `export { default } from …`
    — but NOT a renamed re-export like `export { default as X } from …`, which
    exposes only the named binding. */
export const hasDefaultExport = (source: string): boolean => {
  if (/\bexport\s+default\b/u.test(source)) return true;
  for (const match of source.matchAll(EXPORT_LIST)) {
    for (const entry of match[1]!.split(",")) {
      const [local, exported] = entry.trim().split(/\s+as\s+/u).map((part) => part.trim());
      if ((exported ?? local) === "default") return true;
    }
  }
  return false;
};

/** Every named-export binding: the local name to alias plus the exported name. */
const namedExportBindings = (source: string): Array<{ local: string; exported: string; at: number }> => {
  const bindings: Array<{ local: string; exported: string; at: number }> = [];
  const declaration = /\bexport\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gu;
  for (const match of source.matchAll(declaration)) {
    bindings.push({ local: match[1]!, exported: match[1]!, at: match.index ?? 0 });
  }
  // Local export lists only — a `from` re-export has no local binding to alias.
  const list = /\bexport\s*\{([^}]*)\}(?!\s*from\b)/gu;
  for (const match of source.matchAll(list)) {
    for (const entry of match[1]!.split(",")) {
      const [local, exported] = entry.trim().split(/\s+as\s+/u).map((part) => part.trim());
      if (!local || !/^[A-Za-z_$][\w$]*$/u.test(local)) continue;
      bindings.push({ local, exported: exported ?? local, at: match.index ?? 0 });
    }
  }
  return bindings.sort((left, right) => left.at - right.at);
};

/**
 * ENG-348 — the generated-component entry source a fork ships. The jail entry
 * renders only a default export, but a host may register a NAMED export as
 * remixable and sync captures its module verbatim; forking that capture as-is
 * crashes at render ("must have a React default export"). Synthesize the
 * default export by aliasing the captured component's named export. A source
 * that already has a default export — or offers no component-cased export to
 * alias — passes through verbatim.
 */
export const pinForkSource = (source: string): string => {
  if (hasDefaultExport(source)) return source;
  const component = namedExportBindings(source).find(({ exported }) => /^[A-Z]/u.test(exported));
  if (component === undefined) return source;
  return `${source}\nexport { ${component.local} as default };\n`;
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
 * 06-apps §8 — one drifted pin: the host component changed (or its baseline
 * disappeared) under a fork, so the fork's `base` no longer names the source
 * the host is running. SERVER-AUTHORITATIVE when it rides an open() payload:
 * only `detectPinDrift` over the composition's loaded baselines writes it.
 */
export interface PinDrift {
  slot: string;
  /** The generated-component name the fork ships under (`pinComponentName`). */
  component: string;
  /** The baseline hash the pin was forked from (`Pin.base`). */
  baseHash: string;
  /** The hash of the currently captured host baseline, when one exists. */
  baselineHash?: string;
  reason: "baseline-changed" | "baseline-missing";
}

/**
 * 06-apps §8 — "a host update to the component marks the pin drifted". Pure
 * over the app document and the composition's loaded baselines so the opener,
 * the edit path, and the rebase surface all report the same verdict.
 */
export const detectPinDrift = (
  doc: AppDocument,
  baselines: readonly PinBaseline[],
): PinDrift[] => (doc.pins ?? []).flatMap((pin): PinDrift[] => {
  const baseline = baselines.find((candidate) => candidate.slot === pin.slot);
  if (baseline?.hash === pin.base) return [];
  return [{
    slot: pin.slot,
    component: pinComponentName(pin.slot),
    baseHash: pin.base,
    ...(baseline === undefined ? {} : { baselineHash: baseline.hash }),
    reason: baseline === undefined ? "baseline-missing" : "baseline-changed",
  }];
});

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
