import {
  VendoError,
  appIdSchema,
  isoDateTimeSchema,
  type AppId,
  type IsoDateTime,
} from "@vendoai/core";
import {
  pinComponentName,
  type AppDocument,
  type Pin,
} from "../../contract/index.js";
import { z } from "zod";

/** The fork's generated-component name now lives in core, beside `Pin` — both
 *  sides of the fork seam need it and `ui → apps` is not a legal edge. Kept on
 *  this module's surface so every pin caller still has one import. */
export { pinComponentName };

/**
 * The captured-baseline SHAPE lives on the contract door (`contract/seed.ts`)
 * under its converged names, because the console reads the same bytes from a
 * browser. The server half keeps the `Pin*` spelling until `AppsRuntime.pins`
 * becomes `AppsRuntime.seed`, so these aliases are the whole of the difference.
 */
import { seedBaselineSchema, type SeedBaseline, type SeedStyle, type SeedSubSource } from "../../contract/seed.js";

export const pinBaselineSchema = seedBaselineSchema;
export type PinBaseline = SeedBaseline;
export type PinStyle = SeedStyle;
export type PinSubSource = SeedSubSource;

/** Is this component name a captured host slot's? The counterpart of
 *  {@link pinComponentName}, for the seams that hold a document's components
 *  but not its `pins` — the paint floor checks a compiled `app.vendo`, and a
 *  checkout prints pinned sources into that file alongside the model's islands.
 *  Captured host source is not a model island: it keeps its imports and is
 *  never put through the ambient contract. */
export const isPinComponentName = (name: string): boolean =>
  /^Pinned[A-Za-z0-9]*[0-9a-f]{8}$/.test(name);

/**
 * Blank comment and string/template contents (length-preserving) so export
 * detection never matches commented-out or quoted code. (Adapted from the
 * `stripComments` helper sync's extraction carried before it moved onto the
 * TypeScript AST — actions may not be imported here.)
 */
const blankCommentsAndStrings = (source: string): string => {
  let output = "";
  let quote: "'" | "\"" | "`" | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (quote) {
      if (escaped) {
        escaped = false;
        output += " ";
        continue;
      }
      if (character === "\\") {
        escaped = true;
        output += " ";
        continue;
      }
      if (character === quote) {
        quote = null;
        output += character;
        continue;
      }
      output += character === "\n" ? "\n" : " ";
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index += 1;
      }
      if (index < source.length) output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < source.length) output += "  ";
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
};

const EXPORT_LIST = /\bexport\s*\{([^}]*)\}/gu;

/** Whether the fork entry source exposes the default export the jail renders:
    `export default …`, `export { X as default }`, or `export { default } from …`
    — but NOT a renamed re-export like `export { default as X } from …`, which
    exposes only the named binding. */
export const hasDefaultExport = (rawSource: string): boolean => {
  const source = blankCommentsAndStrings(rawSource);
  // `export default interface …` (and any type-level default) is erased from
  // the emitted JavaScript, so it is not a runtime default export.
  if (/\bexport\s+default\b(?!\s+(?:interface|type)\b)/u.test(source)) return true;
  for (const match of source.matchAll(EXPORT_LIST)) {
    for (const entry of match[1]!.split(",")) {
      const trimmed = entry.trim();
      // A `type` entry is erased from the emitted JavaScript — no runtime default.
      if (/^type\s/u.test(trimmed)) continue;
      const [local, exported] = trimmed.split(/\s+as\s+/u).map((part) => part.trim());
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
  const component = namedExportBindings(blankCommentsAndStrings(source))
    .find(({ exported }) => /^[A-Z]/u.test(exported));
  if (component === undefined) return source;
  return `${source}\nexport { ${component.local} as default };\n`;
};

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
