/**
 * The component bundle — what sits in a generated seat.
 *
 * These shapes are the ON-DISK and ON-THE-WIRE format of a captured host
 * component (`.vendo/components/**`), so they belong to the contract rather than
 * to the capture that writes them: the console, the jail renderer and `@vendoai/actions`
 * all read them, and the browser halves of those readers must not pull node code
 * in to speak the format. `@vendoai/actions` re-exports every name from here, so
 * its public surface is unchanged.
 */
import { bundleOf, type ComponentEntry } from "@vendoai/core";
import { z } from "zod";

/**
 * The bundle itself, and the entry it sits in. Declared in `@vendoai/core`
 * beside the `AppDocument.components` field it types — core's store conformance
 * kit parses a stored row with `appDocumentSchema` and may not reach up into
 * this package — and re-exported here, never re-declared, so the format door
 * is the one place a consumer reads. Same rule as the three bundle limits.
 */
export {
  bundleOf,
  componentBundleSchema,
  componentEntrySchema,
  type ComponentBundle,
  type ComponentEntry,
} from "@vendoai/core";

/** The stored map as bare sources — what the printer, the tree assembler and
 *  the jail all want. The only place the whole map is unwrapped, so no caller
 *  has to know a legacy entry from a bundle. */
export const componentSources = (
  components: Record<string, ComponentEntry> | undefined,
): Record<string, string> =>
  Object.fromEntries(Object.entries(components ?? {}).map(([name, entry]) => [name, bundleOf(entry).source]));

/**
 * One captured module, content-addressed by the sha-256 hex of its canonical
 * JSON. Written to `.vendo/components/modules/<hex>.json` and pushed to the
 * Cloud blob namespace under the same key, so ten components importing one
 * `format-currency.ts` store ONE copy and reference it ten times. A captured
 * stylesheet is the same shape with no imports.
 */
export interface CapturedModule {
  source: string;
  /** Import specifier -> captured module id (root-relative posix path). */
  imports?: Record<string, string>;
}

export const capturedModuleSchema = z.object({
  source: z.string(),
  imports: z.record(z.string()).optional(),
}).passthrough() satisfies z.ZodType<CapturedModule>;

/**
 * Why a registered component has no captured source. Every reason is recorded,
 * not just the one that is easy to explain: a console tile that says WHY it
 * cannot preview a component is the difference between a bug report and a
 * one-line fix. `detail` is a finished sentence a surface can show verbatim.
 */
export const HOST_COMPONENT_SKIP_REASONS = [
  /** The import closure blew the per-component byte budget. */
  "too-large",
  /** The closure imports specifiers the jail cannot resolve (a package, a
   *  component-local stylesheet), so loading it would throw. */
  "unsupported-imports",
  /** Registered as a module's default export, but the module has none. */
  "no-default-export",
  /** The module default-exports something ELSE, so the registered binding
   *  cannot be given the default export the jail renders. */
  "default-export-conflict",
  /** Declared inside node_modules — package code is never captured. */
  "in-package",
  /** The registered value has no named declaration to re-export. */
  "no-named-declaration",
] as const;

export type HostComponentSkipReason = (typeof HOST_COMPONENT_SKIP_REASONS)[number];

export interface HostComponentSkip {
  reason: HostComponentSkipReason;
  /** One finished sentence, safe to render as-is. */
  detail: string;
  /** `too-large`: bytes the closure needed, the budget, and the biggest module. */
  bytes?: number;
  budgetBytes?: number;
  largest?: string;
  /** `unsupported-imports`: the specifiers the jail cannot resolve. */
  specifiers?: string[];
}

/**
 * One registered host component, captured by sync so the console can render it
 * for real instead of a labeled placeholder (`.vendo/components/<Name>.json`).
 * Holds no source: every byte lives in a content-addressed `CapturedModule`, so
 * the record stays small enough that listing the collection IS the hash
 * manifest a push compares against.
 */
export interface CapturedHostComponent {
  /** The name the host registered — the name generated trees reference. */
  name: string;
  /** Content hash of the whole capture (refs + structure), `sha256:<hex>`. */
  hash: string;
  capturedAt: string;
  /** Root-relative posix path of the module that declares the component. */
  module: string;
  /** The binding inside `module` to render. "default" means render the module
   *  as-is; anything else is a local (possibly unexported) declaration, and
   *  `hostComponentEntrySource` turns it into the jail's default export. */
  export?: string;
  /** Content address of the entry module. Absent when `skipped` is set. */
  entry?: string;
  /** Captured module id -> content address, for the whole import closure. */
  modules?: Record<string, string>;
  /** App-root stylesheets, shared by every component in the project. */
  styles?: Array<{ path: string; ref: string }>;
  /** Total captured bytes (entry + closure), for budget accounting. */
  bytes?: number;
  /**
   * Every package this capture needs at render time — the ones the jail bundles
   * (clsx / tailwind-merge / zod) and the ones a preview fetches from the pinned
   * CDN (`packages` below). A consumer that cannot supply one MUST show an
   * honest "preview unavailable" tile: without this field the require throws, a
   * `streaming` surface swallows it into a shimmer skeleton, and the component
   * is indistinguishable from one still loading. Consumers predating CDN
   * loading find the CDN packages unsatisfied here and degrade honestly —
   * which is exactly why the CDN pins live in a separate field.
   */
  requires?: string[];
  /**
   * PREVIEW VENUE ONLY. Import specifier -> `<name>@<exact installed
   * version>[/subpath]`, for every package a preview may load from a pinned
   * CDN. Never a range and never a tag: the version is
   * the one the host has installed, and one that cannot be resolved exactly
   * makes the component an honest skip instead.
   *
   * A remix fork rendering in a customer's own page must never reach a CDN, so
   * nothing on the production path ever copies this into a furnishing (see
   * `attachPinFurnishings`, and the strip in `stripServerAuthoritativeFields`).
   */
  packages?: Record<string, string>;
  /**
   * The rehearsal seed a preview renders with, parsed from the registration's
   * own first usable `examples` string.
   *
   * Load-bearing, not a nicety. A registered component is written to render
   * nothing until its data binds (`if (!series?.length) return null` — what the
   * docs recommend and what every demo component does), and a preview has NO
   * data plane: every query stubs to `[]`. Without a seed the module loads, the
   * component correctly draws nothing, and the surface sits on a streaming
   * silhouette forever. `sampleProps` is exactly this seam, and pin baselines
   * already carry it.
   */
  sampleProps?: Record<string, unknown>;
  /**
   * Which rung of the seed ladder produced `sampleProps`: the host's own
   * declared `examples`, or values synthesized from its declared props schema.
   *
   * A SIBLING of `sampleProps`, deliberately not a key inside it — the jail
   * spreads `sampleProps` straight onto the component's props, so an `origin`
   * key in there would be passed to the component as a prop and could collide
   * with a real one. Kept out here, a surface can still say "preview uses
   * generated sample data" instead of implying the numbers are real.
   */
  sampleOrigin?: "declared" | "generated";
  /** Present INSTEAD of `sampleProps`, so a surface can label the gap ("no
   *  sample data") rather than spin. Absent whenever `sampleProps` is set. */
  noSampleProps?: HostComponentSampleGap;
  skipped?: HostComponentSkip;
}

/** Why a captured component has no preview seed. Distinct from `skipped`: the
 *  capture SUCCEEDED, there is just nothing to render it with. */
export interface HostComponentSampleGap {
  reason: "no-examples" | "unreadable-examples" | "unrepresentable-props";
  /** One finished sentence, safe to render as-is. */
  detail: string;
}

export const capturedHostComponentSchema = z.object({
  name: z.string().min(1),
  hash: z.string().startsWith("sha256:"),
  capturedAt: z.string(),
  module: z.string().min(1),
  export: z.string().min(1).optional(),
  entry: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  modules: z.record(z.string().regex(/^[0-9a-f]{64}$/u)).optional(),
  styles: z.array(z.object({ path: z.string(), ref: z.string().regex(/^[0-9a-f]{64}$/u) })).optional(),
  bytes: z.number().optional(),
  requires: z.array(z.string()).optional(),
  packages: z.record(z.string()).optional(),
  sampleProps: z.record(z.unknown()).optional(),
  sampleOrigin: z.enum(["declared", "generated"]).optional(),
  noSampleProps: z.object({
    reason: z.enum(["no-examples", "unreadable-examples", "unrepresentable-props"]),
    detail: z.string(),
  }).passthrough().optional(),
  skipped: z.object({
    reason: z.enum(HOST_COMPONENT_SKIP_REASONS),
    detail: z.string(),
    bytes: z.number().optional(),
    budgetBytes: z.number().optional(),
    largest: z.string().optional(),
    specifiers: z.array(z.string()).optional(),
  }).passthrough().optional(),
}).passthrough() satisfies z.ZodType<CapturedHostComponent>;

/** The jail renders a module's DEFAULT export, but a host registers whatever
 *  binding it likes — including a component its module never exports. Capture
 *  records the binding; this turns the stored module into a renderable entry.
 *  Capture guarantees the append is legal (a module that already
 *  default-exports something else is skipped with a warning instead). */
export function hostComponentEntrySource(source: string, exportName = "default"): string {
  return exportName === "default" ? source : `${source}\nexport { ${exportName} as default };\n`;
}
