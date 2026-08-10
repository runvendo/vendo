/**
 * Remix provenance — the captured host baseline a seeded app starts from.
 *
 * The SHAPE belongs on the contract door: it is the on-disk format of
 * `.vendo/remixable/<slot>.json`, and the console reads those bytes from a
 * browser. The behavior that acts on it (capture drift, fork, ship diff) stays
 * in the server half.
 *
 * `Seed*` is the name the whole remix vocabulary is converging on — a remix is
 * an app created from something existing, and "pin" only ever named the
 * mechanism. The server half still speaks `Pin*` through aliases in
 * `server/remix/pins.ts`; those die with the `AppsRuntime.pins` → `seed`
 * surface rename.
 */
import { isoDateTimeSchema, type IsoDateTime, type Json } from "@vendoai/core";
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
