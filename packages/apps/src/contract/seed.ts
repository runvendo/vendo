/**
 * Remix provenance — the captured host baseline a seeded app starts from.
 *
 * The SHAPE belongs on the contract door: it is the on-disk format of
 * `.vendo/remixable/<slot>.json`, and the console reads those bytes from a
 * browser — as do the pure verdicts over it (drift, the entry-source rule).
 * What READS or WRITES a store (the seed surface, ship diff) stays server-side.
 *
 * `Seed*` is the whole remix vocabulary: a remix is an app created from
 * something that already existed, and "pin" only ever named the mechanism.
 */
import {
  isoDateTimeSchema,
  seedComponentName,
  type AppDocument,
  type IsoDateTime,
  type Json,
} from "@vendoai/core";
import { z } from "zod";

/** 06-apps §8 — source captured from one host remixable component slot. */
export interface SeedBaseline {
  slot: string;
  source: string;
  hash: string;
  exportable: boolean;
  capturedAt: IsoDateTime;
  /** Remix final shape (2026-08-02) — the component kind, captured by sync
   *  from the `<Remixable review>` wrapper prop: a fork of a review-kind
   *  baseline is invisible to its own user until a host reviewer approves,
   *  then mounts natively. Absent = instant (jailed, no review process). */
  review?: boolean;
  sourceImports?: Record<string, string>;
  subSources?: Record<string, SeedSubSource>;
  sampleProps?: Record<string, Json>;
  styles?: SeedStyle[];
}

/** Captured source-owned virtual module plus its own resolved import table. */
export interface SeedSubSource {
  source: string;
  imports: Record<string, string>;
}

/** One inert host stylesheet snapshot captured from a canonical app root. */
export interface SeedStyle {
  path: string;
  css: string;
}

const seedSubSourceSchema = z.object({
  source: z.string(),
  imports: z.record(z.string()),
}).passthrough() satisfies z.ZodType<SeedSubSource>;

const seedStyleSchema = z.object({
  path: z.string(),
  css: z.string(),
}).passthrough() satisfies z.ZodType<SeedStyle>;

/** 06-apps §8 — validated persisted representation of a captured host baseline. */
export const seedBaselineSchema = z.object({
  slot: z.string(),
  source: z.string(),
  hash: z.string().startsWith("sha256:"),
  exportable: z.boolean(),
  capturedAt: isoDateTimeSchema,
  review: z.boolean().optional(),
  sourceImports: z.record(z.string()).optional(),
  subSources: z.record(seedSubSourceSchema).optional(),
  sampleProps: z.record(z.unknown()).optional(),
  styles: z.array(seedStyleSchema).optional(),
}).passthrough() satisfies z.ZodType<SeedBaseline>;

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

/** Whether the seeded entry source exposes the default export the jail renders:
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
 * ENG-348 — the generated-component entry source a seeded app ships. The jail entry
 * renders only a default export, but a host may register a NAMED export as
 * remixable and sync captures its module verbatim; seeding an app from that capture as-is
 * crashes at render ("must have a React default export"). Synthesize the
 * default export by aliasing the captured component's named export. A source
 * that already has a default export — or offers no component-cased export to
 * alias — passes through verbatim.
 */
export const seedForkSource = (source: string): string => {
  if (hasDefaultExport(source)) return source;
  const component = namedExportBindings(blankCommentsAndStrings(source))
    .find(({ exported }) => /^[A-Z]/u.test(exported));
  if (component === undefined) return source;
  return `${source}\nexport { ${component.local} as default };\n`;
};


/**
 * Is this component name a seeded app's copy of a captured host component? The
 * counterpart of {@link seedComponentName}, for the seams that hold a document's
 * components but not its `seed` — a checkout prints seeded sources into
 * `app.vendo` alongside the model's islands.
 *
 * It does NOT buy an admission exemption. Seeded source used to skip the island
 * gate entirely; it now faces the same floor as anything else, because a bundle
 * a host captured is still a bundle this runtime is about to render.
 */
export const isSeedComponentName = (name: string): boolean =>
  /^Pinned[A-Za-z0-9]*[0-9a-f]{8}$/.test(name);

/**
 * The host component a seeded app started from changed under it (or its
 * baseline disappeared). A WARNING, never an action: re-seeding is always the
 * user's choice, because it replaces whatever they have made with the pristine
 * new component.
 */
export interface SeedDrift {
  /** The captured host component the app was seeded from (`AppSeed.component`). */
  component: string;
  /** The generated-component name the copy ships under (`seedComponentName`). */
  componentName: string;
  /** The baseline hash the seed records (`AppSeed.baseline`). */
  baseline: string;
  /** The hash of the currently captured host baseline, when one exists. */
  current?: string;
  reason: "baseline-changed" | "baseline-missing";
}

/**
 * Generic drift: the seed's hash is not the hash the host captures today.
 *
 * Pure over the document and the composition's loaded baselines, so the opener,
 * the edit path and the seed surface all report the same verdict. One seed, one
 * verdict — there are no rows to walk.
 */
export const seedDrift = (
  document: AppDocument,
  baselines: readonly SeedBaseline[],
): SeedDrift | null => {
  const seed = document.seed;
  if (seed === undefined) return null;
  const baseline = baselines.find((candidate) => candidate.slot === seed.component);
  if (baseline?.hash === seed.baseline) return null;
  return {
    component: seed.component,
    componentName: seedComponentName(seed.component),
    baseline: seed.baseline,
    ...(baseline === undefined ? {} : { current: baseline.hash }),
    reason: baseline === undefined ? "baseline-missing" : "baseline-changed",
  };
};
