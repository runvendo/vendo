/**
 * THE briefing pack — everything a writer is told about the PRODUCT, assembled
 * once and handed to both generation rungs byte for byte.
 *
 * The two rungs are the screen agent (a document out of this host's components)
 * and the box (real code on a machine). They used to be told different things:
 * the screen agent got the theme, the design rules and the tool shape card and
 * never saw `.vendo/brief.md`; the box got neither theme, nor rules, nor
 * catalog, nor brief. Product knowledge that only one writer has is a silent
 * gap — the person cannot tell which rung answered, so both must know the same
 * things.
 *
 * INSTRUCTIONS are the other half and stay per-rung on purpose: the screen
 * agent's dialect manual and the box's scaffold task brief are different jobs.
 * This file renders knowledge, never instructions.
 */
import { z } from "zod";
import { vendoRouteMapSchema, vendoRouteParams, vendoThemeSchema, type VendoRouteMap, type VendoTheme } from "./catalog.js";

/** One host component, as a writer needs to know about it: the name it may use
 *  and the FIRST line of its description — `catalogThemeSummary`'s existing
 *  one-line reduction, kept verbatim (d5). */
export interface CatalogSummaryEntry {
  name: string;
  description: string;
}

export interface BriefingPack {
  /** `.vendo/theme.json`, verbatim — the tokens an island actually styles with,
   *  never a one-line summary of them. Absent when the host set no theme. */
  theme?: VendoTheme;
  /** `.vendo/design-rules.md` (or `apps.designRules`), verbatim. */
  designRules?: string;
  /** `.vendo/brief.md` — what this product IS. */
  brief?: string;
  /** The host's own components, one line each. */
  catalog: readonly CatalogSummaryEntry[];
  /** The pages this product registered — the whole vocabulary a `<Link to>` may
   *  name. Absent when the host registered none, which is "nothing may link". */
  routes?: VendoRouteMap;
  /** The semantics-annotated tool shape card: what every tool a binding may
   *  name really returns, in this host's own units. */
  hostSemantics: string;
}

export const catalogSummaryEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
}) satisfies z.ZodType<CatalogSummaryEntry>;

export const briefingPackSchema: z.ZodType<BriefingPack> = z.object({
  theme: vendoThemeSchema.optional(),
  designRules: z.string().optional(),
  brief: z.string().optional(),
  catalog: z.array(catalogSummaryEntrySchema).readonly(),
  routes: vendoRouteMapSchema.optional(),
  hostSemantics: z.string(),
});

/**
 * ONE rendering. Both rungs get these exact bytes.
 *
 * The section wording is the wording the screen agent already read, so the pack
 * is a redistribution of what a writer is told rather than a rewrite of it:
 * `THEME TOKENS:` and `HOST DESIGN RULES:` are unchanged, "(none provided)" is
 * still the difference between a model that knows there are no house rules and
 * one that was never told either way, and the component lines keep the catalog
 * summary's `- name: first line` shape.
 */
export function renderBriefingPack(pack: BriefingPack): string {
  const sections: string[] = [];
  if (pack.theme !== undefined) {
    sections.push(`THEME TOKENS:\n${JSON.stringify(pack.theme, null, 2)}`);
  }
  const rules = pack.designRules?.trim();
  sections.push(`HOST DESIGN RULES:\n${rules === undefined || rules === "" ? "(none provided)" : rules}`);
  const brief = pack.brief?.trim();
  if (brief !== undefined && brief !== "") {
    sections.push(`WHAT THIS PRODUCT IS:\n${brief}`);
  }
  if (pack.catalog.length > 0) {
    const lines = pack.catalog.map((entry) => `- ${entry.name}: ${entry.description}`.trimEnd());
    sections.push(`Host components (usable in generated views beside the built-in primitives)\n${lines.join("\n")}`);
  }
  const routes = Object.entries(pack.routes ?? {});
  if (routes.length > 0) {
    // NAMES and descriptions only, never the paths. A writer picks a page by
    // what it IS, and a path in the prompt is a URL to copy — the one thing
    // generated output must never author. The `:params` a path takes are named
    // because a link has to fill them, but their values are substituted into
    // the host's own path and encoded there (`resolveVendoRoute`).
    const lines = routes.map(([name, route]) => {
      const params = vendoRouteParams(route.path);
      return `- ${name}: ${route.description}${params.length === 0 ? "" : ` (fill params: ${params.join(", ")})`}`;
    });
    sections.push("ROUTES (this product's own pages — what a <Link to=\"…\"> may send someone to)."
      + " The NAME is the whole vocabulary: a link selects one of these, it never writes a URL,"
      + ` and a name that is not on this list is refused.\n${lines.join("\n")}`);
  }
  const semantics = pack.hostSemantics.trim();
  if (semantics !== "") sections.push(semantics);
  return sections.join("\n\n");
}

/** The catalog's one-line reduction, applied. A multi-line description keeps
 *  only its first line — the known, accepted edge of d5. */
export const catalogSummaryEntries = (
  catalog: ReadonlyArray<{ name: string; description: string }>,
): CatalogSummaryEntry[] => catalog.map(({ name, description }) => ({
  name,
  description: description.split("\n", 1)[0] ?? "",
}));
