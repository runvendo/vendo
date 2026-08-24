/**
 * Remix provenance — the captured host baseline a seeded app starts from.
 *
 * The SHAPE belongs on the contract door: it is the on-disk format of
 * `.vendo/remixable/<slot>.json`, and the console reads those bytes from a
 * browser — as do the pure verdicts over it (drift).
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
  /** Vestigial capture metadata. The review-kind venue it once gated (a fork
   *  mounting natively in the host page on approval) is gone, so it no longer
   *  changes how a fork renders — every fork renders sandboxed. */
  review?: boolean;
  sourceImports?: Record<string, string>;
  subSources?: Record<string, SeedSubSource>;
  sampleProps?: Record<string, Json>;
  styles?: SeedStyle[];
  ported?: SeedPort;
}

/** The splitter's output for this slot: the PORTED half a remix starts from.
 *  Absent = the component was not provably splittable and gets no ✦. */
export interface SeedPort {
  /** The ported component: real TSX in the screen dialect, host classNames intact. */
  source: string;
  /** Envelope names this port's `useQuery`/`tools.*` calls bind to. */
  tools: string[];
  /** Component names the port renders as holes (npm + host sub-components). */
  holes: string[];
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

const seedPortSchema = z.object({
  source: z.string(),
  tools: z.array(z.string()),
  holes: z.array(z.string()),
}).passthrough() satisfies z.ZodType<SeedPort>;

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
  ported: seedPortSchema.optional(),
}).passthrough() satisfies z.ZodType<SeedBaseline>;

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
