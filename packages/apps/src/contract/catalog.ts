import { z } from "zod";
import { log, type JsonSchema } from "@vendoai/core";

/** 01-core §14 */
export interface StandardSchema {
  "~standard": { validate(value: unknown): unknown };
}

/** 01-core §14 (amended 2026-07-18): one optional props schema per entry;
 * the model-facing JSON Schema is derived internally by the composition —
 * hosts never hand-write it (`propsJsonSchema` is removed). Schema-less
 * entries are legal: the model infers props and validation is permissive. */
export interface RegisteredComponent {
  name: string;
  description: string;
  propsSchema?: StandardSchema;
  examples?: string[];
}

/** 01-core §14 */
export type ComponentCatalog = ReadonlyArray<RegisteredComponent>;

/** 01-core §14 (2026-07-18 amendment) — name-keyed registry form. The same
 * object serves both sides: the server reads the data fields, <VendoProvider>
 * reads the component references. The composition normalizes registry →
 * catalog entry by entry: key → `name`, `props` → `propsSchema`, `component`
 * dropped (the server MUST IGNORE it — never touched, never executed). */
export interface ComponentRegistryEntry {
  /** Host component reference for the client side; ignored server-side. */
  component: unknown;
  description: string;
  /** The ONE optional props schema — same StandardSchema, same derivation. */
  props?: StandardSchema;
  examples?: string[];
}

/** 01-core §14 — keys are component names (PascalCase). */
export type ComponentRegistry = Record<string, ComponentRegistryEntry>;

/** The composition's internal normalized catalog entry (01 §14 amendment):
 * `propsJsonSchema` here is DERIVED — from the entry's single zod schema at
 * normalization time, or loaded verbatim from catalog@1's disk `propsSchema`
 * field — never hand-written by hosts. It drives both the generation prompt
 * and generated-props validation (04 §1). */
export interface NormalizedCatalogEntry extends RegisteredComponent {
  propsJsonSchema?: JsonSchema;
}

/** The normalized internal catalog the composition hands to the apps block. */
export type NormalizedCatalog = ReadonlyArray<NormalizedCatalogEntry>;

/** 01-core §14. The shape only: `./theme.js` owns the defaults, the merge, and
 * the one mapping onto `--vendo-*` CSS variables that every surface renders
 * through. */
export interface VendoTheme {
  colors: {
    background: string;
    surface: string;
    text: string;
    muted: string;
    accent: string;
    accentText: string;
    danger: string;
    border: string;
    success?: string;
    warning?: string;
    surfaceRaised?: string;
  };
  typography: {
    fontFamily: string;
    headingFamily?: string;
    monoFamily?: string;
    baseSize: string;
    weightNormal?: string;
    weightEmphasis?: string;
    letterSpacing?: string;
    lineHeightBody?: string;
    lineHeightHeading?: string;
  };
  radius: { small: string; medium: string; large: string };
  shadow?: { small: string; medium: string; large: string };
  density: "compact" | "comfortable";
  motion: "full" | "reduced";
  borderWidth?: string;
  /** Categorical chart series, in order; beyond six a chart reads the ramp
   * `chartPaletteFor` derives from the accent. */
  chartPalette?: string[];
  motionDuration?: string;
  motionEasing?: string;
}

/** 01-core §14. Every field added after the original eight-color shape is
 * OPTIONAL: a failed parse discards the WHOLE theme file, so a required addition
 * would blank the brand of every host whose theme predates it. */
export const vendoThemeSchema = z.object({
  colors: z.object({
    background: z.string(),
    surface: z.string(),
    text: z.string(),
    muted: z.string(),
    accent: z.string(),
    accentText: z.string(),
    danger: z.string(),
    border: z.string(),
    success: z.string().optional(),
    warning: z.string().optional(),
    surfaceRaised: z.string().optional(),
  }).passthrough(),
  typography: z.object({
    fontFamily: z.string(),
    headingFamily: z.string().optional(),
    monoFamily: z.string().optional(),
    baseSize: z.string(),
    weightNormal: z.string().optional(),
    weightEmphasis: z.string().optional(),
    letterSpacing: z.string().optional(),
    lineHeightBody: z.string().optional(),
    lineHeightHeading: z.string().optional(),
  }).passthrough(),
  radius: z.object({
    small: z.string(),
    medium: z.string(),
    large: z.string(),
  }).passthrough(),
  shadow: z.object({
    small: z.string(),
    medium: z.string(),
    large: z.string(),
  }).passthrough().optional(),
  density: z.enum(["compact", "comfortable"]),
  motion: z.enum(["full", "reduced"]),
  borderWidth: z.string().optional(),
  // Truncate rather than reject: a failed parse discards the WHOLE theme file,
  // so a seventh color would cost the host its fonts, colors and radius too.
  chartPalette: z.array(z.string()).transform((palette) => {
    if (palette.length > 6) {
      log({
        code: "apps.theme-palette-truncated",
        level: "warn",
        message: `[vendo] theme chartPalette has ${palette.length} colors; only the first 6 are used`,
      });
    }
    return palette.slice(0, 6);
  }).optional(),
  motionDuration: z.string().optional(),
  motionEasing: z.string().optional(),
}).passthrough() satisfies z.ZodType<VendoTheme>;

/** One page of the host product a generated view may send someone to. The
 * `description` is what picks between them — the agent reads it, never the path. */
export interface VendoRoute {
  path: string;
  description: string;
}

/** The host's route registry, keyed by the NAME generated UI links to. Paths are
 * the host's own; a link names a key, so nothing generated authors a URL. */
export type VendoRouteMap = Record<string, VendoRoute>;

/** A resolved navigation — what a host's `onNavigate` is handed. `path` is the
 * REGISTERED path with the link's params substituted and URL-encoded. */
export interface VendoNavigation {
  to: string;
  path: string;
  params?: Record<string, string>;
}

export const vendoRouteSchema = z.object({
  path: z.string(),
  description: z.string(),
}) satisfies z.ZodType<VendoRoute>;

export const vendoRouteMapSchema = z.record(z.string(), vendoRouteSchema);

/** A path SEGMENT that is a parameter: the whole segment, colon-prefixed.
 *
 * A colon is legal inside a segment — `/reports/2026:Q3` is a real path — and
 * `:(\w+)` anywhere in the string read that as a parameter named `Q3`. The host
 * can never fill a blank that is not there, so the route resolved to
 * `undefined`, the link rendered as inert text, the floor refused the screen and
 * the briefing advertised a parameter that does not exist. Anchoring to the
 * segment is the line between a parameter and a literal colon. */
const PARAM_SEGMENT = /^:(\w+)$/u;

/** The parameters a registered path takes.
 *
 * ONE definition, because THREE readers must agree about it and they break in a
 * correlated way when they drift: this file's resolver, the floor's
 * `routes-exist` check, and the briefing's ROUTES section. A path whose
 * parameters are read differently by any two of them is a link that resolves
 * and is refused, or is accepted and goes nowhere. */
export const vendoRouteParams = (path: string): string[] =>
  path.split("/").flatMap((segment) => PARAM_SEGMENT.exec(segment)?.[1] ?? []);

/** The colon-led segments this resolver cannot fill — `:slug.html`, `:id-2`.
 *
 * The exact COMPLEMENT of {@link vendoRouteParams} over colon-led segments, from
 * the same `PARAM_SEGMENT`: every segment starting with `:` is either a
 * parameter or named here, never both and never neither. That is what makes
 * "supported" and "refused" agree by construction instead of by two authors
 * keeping two rules in step — and the gap between them is precisely where
 * `/posts/:slug.html` fell, reported as taking NO parameters while the resolver
 * handed back a path still carrying `:slug.html`. Nothing could fill it, so the
 * link died quietly, and the floor and the briefing read it the same wrong way.
 *
 * A host hears about this at registration (`createVendo`), never at render. */
export const unsupportedRouteParams = (path: string): string[] =>
  path.split("/").filter((segment) => segment.startsWith(":") && !PARAM_SEGMENT.test(segment));

/** Resolve a link target against the registry. A name the host never registered
 * — or one whose path has `:params` the link left unfilled — resolves to
 * `undefined`: an unknown route is REFUSED here rather than passed through, so
 * the only strings that can become an href are the host's own. */
export function resolveVendoRoute(
  routes: VendoRouteMap,
  to: string,
  params?: Record<string, string>,
): VendoNavigation | undefined {
  const route = routes[to];
  if (route === undefined) return undefined;
  let unfilled = false;
  // Segment by segment, on the SAME predicate `vendoRouteParams` reads the path
  // with — so what this substitutes and what the other two advertise and enforce
  // cannot come apart.
  const path = route.path.split("/").map((segment) => {
    const key = PARAM_SEGMENT.exec(segment)?.[1];
    if (key === undefined) return segment;
    const value = params?.[key];
    if (value === undefined) {
      unfilled = true;
      return segment;
    }
    return encodeURIComponent(value);
  }).join("/");
  return unfilled ? undefined : { to, path, ...(params === undefined ? {} : { params }) };
}

/** AGENT-1 — 03 §3 item (4): the model-facing summary of the host components a
 * generated view may use and how the host's brand should feel. One succinct
 * block; the agent injects it only for venues that render trees.
 *
 * THE catalog summary — it lived in the umbrella (`vendo/src/catalog.ts`) and
 * belongs beside the catalog shape it reduces, so a second rendering of the same
 * two config keys cannot start disagreeing with this one. */
export function catalogThemeSummary(
  catalog: NormalizedCatalog,
  theme?: VendoTheme,
): string | undefined {
  const sections: string[] = [];
  if (catalog.length > 0) {
    const lines = catalog.map((entry) =>
      `- ${entry.name}: ${entry.description.split("\n", 1)[0] ?? ""}`.trimEnd());
    sections.push(`Host components (usable in generated views beside the built-in primitives)\n${lines.join("\n")}`);
  }
  if (theme !== undefined) {
    sections.push(
      `Theme: ${theme.density} density, ${theme.motion} motion, ${theme.typography.fontFamily} typography.`,
    );
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}
