import { promises as fs } from "node:fs";
import path from "node:path";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { contrastingText, normalizeColor, normalizeLength, resolveCssVarRefs } from "./color.js";
import { parseCssVars, type CssVarDecl } from "./css-vars.js";
import { ENTRY_FILE_CANDIDATES } from "./entry-candidates.js";
import { walk } from "./walk.js";

/**
 * Theme extraction, exact-or-model (kill-list §B2):
 *
 * 1. Allowlist fast-path — conventional shadcn/Tailwind tokens are read
 *    EXACTLY (`--primary`, `--background`, `--font-sans`, ... and their
 *    Tailwind-v4 `--color-*` spellings). No name scoring, no inference.
 * 2. LLM pass — when the allowlist leaves brand slots unfilled, ONE model
 *    call reads the collected CSS + Tailwind config + root layout and fills
 *    the rest, flagging slots it is genuinely unsure about.
 * 3. Anything neither path fills falls back to neutral defaults and is
 *    reported as defaulted — a miss is visible, never a silent wrong brand.
 *
 * theme.json stays the editable source of truth; init shows the palette for
 * a one-glance confirm and asks only about model-flagged uncertainty.
 */

export interface ThemeSlotValues {
  accent: string;
  accentText: string;
  background: string;
  border: string;
  danger: string;
  surface: string;
  text: string;
  mutedText: string;
  radius: string;
  fontFamily: string;
  headingFamily: string;
  baseSize: string;
  density: "compact" | "comfortable";
  motion: "full" | "reduced";
}

export interface ThemeUncertainty {
  slot: keyof ThemeSlotValues;
  note: string;
}

export interface ThemeSummary {
  /** Fully resolved values used to assemble the frozen VendoTheme contract. */
  slots: ThemeSlotValues;
  /** slot -> provenance: the exact token name, "(model)", or a derivation. */
  matched: Record<string, string>;
  /** Slots that fell back to neutral defaults (reported, never silent). */
  defaulted: string[];
  /** Model-flagged genuine uncertainty — init's only theme question trigger. */
  uncertain: ThemeUncertainty[];
  usedModel: boolean;
  errors: string[];
  hasDarkVariant: boolean;
}

export interface ExtractThemeOptions {
  /**
   * Lazily resolves the model for the LLM pass — the SAME seam `vendo refine`
   * uses (`resolveRefineModel`: --model-import, else the host's key +
   * installed provider). Vendo-hosted inference will swap in behind this same
   * seam later. Absent or failing resolution degrades to allowlist + defaults.
   */
  resolveModel?: () => Promise<LanguageModel>;
}

const DEFAULT_THEME_SLOTS: ThemeSlotValues = {
  accent: "#2563eb",
  accentText: "#ffffff",
  background: "#ffffff",
  border: "#e2e8f0",
  danger: "#dc2626",
  surface: "#f8fafc",
  text: "#0f172a",
  mutedText: "#64748b",
  radius: "8px",
  fontFamily: "system-ui, sans-serif",
  headingFamily: "system-ui, sans-serif",
  baseSize: "16px",
  density: "comfortable",
  motion: "full",
};

// ---------------------------------------------------------------------------
// Context gathering — root layout, its CSS graph, Tailwind config.
// ---------------------------------------------------------------------------

interface ContextFile {
  path: string;
  content: string;
}

interface ThemeContext {
  layout: ContextFile | null;
  css: ContextFile[];
  tailwindConfig: ContextFile | null;
}

const CSS_IMPORT_RE = /\bimport\s+(?:[^"']+\s+from\s+)?["']([^"']+\.css)["']|\brequire\(\s*["']([^"']+\.css)["']\s*\)/g;
const CSS_AT_IMPORT_RE = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/g;
const CSS_FALLBACK_NAME = /^(?:globals?|app|main|index|tokens?|theme|styles?)\.css$/;
const MAX_CSS_FILES = 12;
const MAX_FILE_BYTES = 24_000;

async function readCapped(file: string): Promise<string | null> {
  try {
    const content = await fs.readFile(file, "utf8");
    return content.length > MAX_FILE_BYTES ? content.slice(0, MAX_FILE_BYTES) : content;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

function resolveLocalSpec(spec: string, fromDir: string, targetDir: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/")) return path.resolve(fromDir, spec);
  // The near-universal `@/` alias; package-specifier CSS (vendor sheets) is
  // deliberately not chased — host brand tokens live in the host's own tree.
  if (spec.startsWith("@/")) return path.join(targetDir, "src", spec.slice(2));
  return null;
}

async function collectCss(layout: ContextFile | null, targetDir: string): Promise<ContextFile[]> {
  const files: ContextFile[] = [];
  const seen = new Set<string>();
  const visit = async (absolute: string, depth: number): Promise<void> => {
    if (seen.has(absolute) || files.length >= MAX_CSS_FILES || depth > 3) return;
    seen.add(absolute);
    const content = await readCapped(absolute);
    if (content === null) return;
    files.push({ path: path.relative(targetDir, absolute), content });
    for (const match of content.matchAll(CSS_AT_IMPORT_RE)) {
      const spec = match[1]!;
      if (spec === "tailwindcss" || spec.startsWith("http")) continue;
      const resolved = resolveLocalSpec(spec, path.dirname(absolute), targetDir);
      if (resolved === null) continue;
      const candidate = resolved.endsWith(".css") ? resolved : `${resolved}.css`;
      if (await exists(candidate)) await visit(candidate, depth + 1);
      else if (spec.startsWith("@/") && await exists(path.join(targetDir, spec.slice(2)))) {
        await visit(path.join(targetDir, spec.slice(2)), depth + 1);
      }
    }
  };

  if (layout !== null) {
    const layoutDir = path.dirname(path.join(targetDir, layout.path));
    for (const match of layout.content.matchAll(CSS_IMPORT_RE)) {
      const spec = (match[1] ?? match[2])!;
      let resolved = resolveLocalSpec(spec, layoutDir, targetDir);
      if (resolved !== null && spec.startsWith("@/") && !(await exists(resolved))) {
        resolved = path.join(targetDir, spec.slice(2));
      }
      if (resolved !== null && await exists(resolved)) await visit(resolved, 0);
    }
  }
  if (files.length === 0) {
    // No layout-imported CSS found: fall back to conventionally named sheets.
    const all = await walk(targetDir, (rel) => rel.endsWith(".css"), 500);
    const named = all.filter((file) => CSS_FALLBACK_NAME.test(path.basename(file)));
    for (const file of (named.length > 0 ? named : all).slice(0, 4)) await visit(file, 0);
  }
  return files;
}

async function gatherContext(targetDir: string): Promise<ThemeContext> {
  let layout: ContextFile | null = null;
  for (const candidate of ENTRY_FILE_CANDIDATES) {
    const content = await readCapped(path.join(targetDir, candidate));
    if (content !== null) {
      layout = { path: candidate, content };
      break;
    }
  }
  let tailwindConfig: ContextFile | null = null;
  for (const name of ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs"]) {
    const content = await readCapped(path.join(targetDir, name));
    if (content !== null) {
      tailwindConfig = { path: name, content };
      break;
    }
  }
  return { layout, css: await collectCss(layout, targetDir), tailwindConfig };
}

// ---------------------------------------------------------------------------
// Allowlist fast-path — exact reads of documented shadcn/Tailwind tokens.
// ---------------------------------------------------------------------------

type SlotKey = keyof ThemeSlotValues;

/**
 * The shadcn theme-variable vocabulary (ui.shadcn.com/docs/theming), mapped
 * only where the shadcn semantic IS the Vendo slot semantic. Notably absent:
 * shadcn's `--accent` (a hover wash, not the brand color — `--primary` is),
 * `--muted` (a muted surface, not muted text), `--secondary`, `--popover`,
 * `--input`, `--ring`, `--chart-*`, `--sidebar-*`. Each name is also accepted
 * with the Tailwind-v4 `@theme` namespace prefix (`--color-primary`, ...).
 */
const EXACT_COLOR_TOKENS: ReadonlyArray<[SlotKey, string[]]> = [
  ["background", ["--background"]],
  ["text", ["--foreground"]],
  ["surface", ["--card"]],
  ["accent", ["--primary"]],
  ["accentText", ["--primary-foreground"]],
  ["mutedText", ["--muted-foreground"]],
  ["border", ["--border"]],
  ["danger", ["--destructive"]],
];

/** Non-color conventions: shadcn `--radius`; Tailwind v4 `--font-*` and
 *  `--text-base` namespaces; Vendo's own documented `--density`/`--motion`. */
const FONT_TOKENS: ReadonlyArray<[SlotKey, string[]]> = [
  ["fontFamily", ["--font-sans"]],
  ["headingFamily", ["--font-heading", "--font-display"]],
];

interface ExactReads {
  values: Partial<ThemeSlotValues>;
  matched: Record<string, string>;
}

function lastLightDecl(vars: CssVarDecl[], names: string[]): CssVarDecl | undefined {
  for (const name of names) {
    const spellings = [name, `--color-${name.slice(2)}`];
    const hit = [...vars].reverse().find((v) => !v.darkScope && spellings.includes(v.name));
    if (hit) return hit;
  }
  return undefined;
}

function normalizeFontStack(value: string): string {
  // Quotes are optional CSS syntax around family names, not identity: "Outfit"
  // and Outfit are the same family (unquoted multi-word names are valid too).
  const stack = value.split(",")
    .map((part) => part.trim().replace(/^(["'])(.*)\1$/, "$2").trim())
    .filter(Boolean)
    .join(", ");
  return /(?:^|,\s*)(?:sans-serif|serif|monospace|cursive|fantasy)(?:\s*,|$)/i.test(stack)
    ? stack
    : `${stack}, sans-serif`;
}

/** Fully-resolved font stack: no var() refs, no CSS structural characters. */
function isSafeFontStack(value: string): boolean {
  return value.length > 0 && !value.includes("var(") && !/[{};\n]/.test(value);
}

function readExact(vars: CssVarDecl[]): ExactReads {
  const values: Partial<ThemeSlotValues> = {};
  const matched: Record<string, string> = {};
  const put = <K extends SlotKey>(slot: K, decl: CssVarDecl | undefined, value: ThemeSlotValues[K] | null) => {
    if (decl === undefined || value === null) return;
    values[slot] = value;
    matched[slot] = decl.name;
  };

  for (const [slot, names] of EXACT_COLOR_TOKENS) {
    const decl = lastLightDecl(vars, names);
    const resolved = decl === undefined ? null : resolveCssVarRefs(decl.value, vars);
    put(slot, decl, resolved === null ? null : normalizeColor(resolved));
  }
  for (const [slot, names] of FONT_TOKENS) {
    const decl = lastLightDecl(vars, names);
    const resolved = decl === undefined ? null : resolveCssVarRefs(decl.value, vars);
    put(slot, decl, resolved !== null && isSafeFontStack(resolved) ? normalizeFontStack(resolved) : null);
  }
  const radius = lastLightDecl(vars, ["--radius"]);
  const radiusResolved = radius === undefined ? null : resolveCssVarRefs(radius.value, vars);
  put("radius", radius, radiusResolved === null ? null : normalizeLength(radiusResolved));
  const baseSize = lastLightDecl(vars, ["--font-size", "--text-base"]);
  const baseResolved = baseSize === undefined ? null : resolveCssVarRefs(baseSize.value, vars);
  put("baseSize", baseSize, baseResolved === null ? null : normalizeLength(baseResolved));
  const density = lastLightDecl(vars, ["--density"]);
  if (density && /^(?:compact|comfortable)$/.test(density.value.trim())) {
    put("density", density, density.value.trim() as ThemeSlotValues["density"]);
  }
  const motion = lastLightDecl(vars, ["--motion"]);
  if (motion && /^(?:full|reduced)$/.test(motion.value.trim())) {
    put("motion", motion, motion.value.trim() as ThemeSlotValues["motion"]);
  }
  return { values, matched };
}

// ---------------------------------------------------------------------------
// LLM pass — one structured call fills what the allowlist could not read.
// ---------------------------------------------------------------------------

/** Brand-defining slots: any of these missing after the exact pass consults
 *  the model, and only doubt about these becomes an init question. The
 *  remaining slots (accentText, headingFamily, baseSize, density, motion)
 *  derive or default safely — accentText derives from the accent by WCAG
 *  contrast, headingFamily inherits fontFamily, and the rest have safe
 *  brand-neutral defaults — so they never trigger a call or a question. */
export const BRAND_SLOTS: readonly SlotKey[] = [
  "accent", "background", "surface", "text", "mutedText",
  "border", "danger", "radius", "fontFamily",
];

const SLOT_KEYS = Object.keys(DEFAULT_THEME_SLOTS) as SlotKey[];

export const modelThemeSchema = z.object({
  slots: z.object({
    accent: z.string().optional(),
    accentText: z.string().optional(),
    background: z.string().optional(),
    border: z.string().optional(),
    danger: z.string().optional(),
    surface: z.string().optional(),
    text: z.string().optional(),
    mutedText: z.string().optional(),
    radius: z.string().optional(),
    fontFamily: z.string().optional(),
    headingFamily: z.string().optional(),
    baseSize: z.string().optional(),
    density: z.enum(["compact", "comfortable"]).optional(),
    motion: z.enum(["full", "reduced"]).optional(),
  }),
  uncertain: z.array(z.object({ slot: z.string(), note: z.string() })).optional(),
});

const MODEL_SYSTEM_PROMPT = [
  "You extract a product's brand theme from its source files for Vendo's theme.json.",
  "Slots: accent (the brand's primary interactive color), accentText (text on accent),",
  "background (page), surface (cards/panels), text (body), mutedText (secondary text),",
  "border (default hairline), danger (destructive/error), radius (default control corner",
  "radius, canonical px), fontFamily (body stack), headingFamily (heading stack, only if",
  "distinct), baseSize (body font size, px), density (compact|comfortable), motion (full|reduced).",
  "",
  "Rules:",
  "- Fill ONLY the requested slots, ONLY from evidence in the provided files.",
  "- Colors must be 6-digit hex. Resolve CSS variables and color functions yourself.",
  "- next/font: the imported font's export name is the family (underscores become spaces).",
  "- A design-token sheet outranks scattered utility classes; dominant usage outranks one-offs.",
  "- Status/state colors (success, positive, negative, warning, error, overdue, verified,",
  "  and colors a comment demotes to data/status-only) are NEVER the brand accent.",
  "- Monochrome brands exist: when the sheet declares no saturated non-status brand color,",
  "  the ink/text color itself is the accent (primary buttons are painted with it).",
  "- radius is the default CONTROL radius (buttons/inputs); a token named for cards or",
  "  popovers rounds cards, which are typically larger than controls.",
  "- An accessibility-only prefers-reduced-motion override does NOT make the brand 'reduced'.",
  "- Omit any slot the files do not evidence. Do not invent plausible values.",
  "- List a slot in `uncertain` ONLY when the files genuinely support multiple different",
  "  answers (a real fork, e.g. two plausible brand colors). A value settled by the rules",
  "  above — monochrome accent, contrast-derived accentText, single-font inheritance,",
  "  browser-default sizing — is NOT uncertain.",
].join("\n");

async function modelPass(
  model: LanguageModel,
  context: ThemeContext,
  exact: ExactReads,
  needed: SlotKey[],
): Promise<z.infer<typeof modelThemeSchema>> {
  const prompt = JSON.stringify({
    neededSlots: needed,
    alreadyExact: exact.values,
    files: [
      ...(context.layout ? [context.layout] : []),
      ...context.css,
      ...(context.tailwindConfig ? [context.tailwindConfig] : []),
    ],
  });
  const result = await generateObject({ model, schema: modelThemeSchema, system: MODEL_SYSTEM_PROMPT, prompt });
  return result.object;
}

/** Deterministic validation of a proposed slot value (model or human). */
export function validateSlotValue(slot: SlotKey, raw: string): string | null {
  const value = raw.trim();
  switch (slot) {
    case "radius":
    case "baseSize":
      return normalizeLength(value);
    case "density":
      return /^(?:compact|comfortable)$/.test(value) ? value : null;
    case "motion":
      return /^(?:full|reduced)$/.test(value) ? value : null;
    case "fontFamily":
    case "headingFamily":
      return isSafeFontStack(value) ? normalizeFontStack(value) : null;
    default:
      return normalizeColor(value);
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export async function extractTheme(
  targetDir: string,
  options: ExtractThemeOptions = {},
): Promise<ThemeSummary> {
  const errors: string[] = [];
  const context = await gatherContext(targetDir);
  const vars: CssVarDecl[] = context.css.flatMap((file) => parseCssVars(file.content, file.path));
  const exact = readExact(vars);

  const needed = SLOT_KEYS.filter((slot) => exact.values[slot] === undefined);
  const coreMissing = BRAND_SLOTS.some((slot) => exact.values[slot] === undefined);
  const fromModel: Partial<Record<SlotKey, string>> = {};
  let uncertain: ThemeUncertainty[] = [];
  let usedModel = false;
  if (coreMissing && options.resolveModel !== undefined) {
    try {
      const model = await options.resolveModel();
      const proposed = await modelPass(model, context, exact, needed);
      usedModel = true;
      for (const slot of needed) {
        const raw = proposed.slots[slot];
        if (raw === undefined) continue;
        const value = validateSlotValue(slot, String(raw));
        if (value !== null) fromModel[slot] = value;
      }
      uncertain = (proposed.uncertain ?? [])
        .filter((entry): entry is ThemeUncertainty => (BRAND_SLOTS as string[]).includes(entry.slot))
        .filter((entry) => exact.values[entry.slot] === undefined);
    } catch (error) {
      errors.push(`theme model pass unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  const slots = { ...DEFAULT_THEME_SLOTS };
  const matched: Record<string, string> = {};
  const defaulted: string[] = [];
  for (const slot of SLOT_KEYS) {
    const exactValue = exact.values[slot];
    const modelValue = fromModel[slot];
    if (exactValue !== undefined) {
      (slots as Record<string, unknown>)[slot] = exactValue;
      matched[slot] = exact.matched[slot]!;
    } else if (modelValue !== undefined) {
      (slots as Record<string, unknown>)[slot] = modelValue;
      matched[slot] = "(model)";
    } else if (slot === "accentText" && (exact.values.accent !== undefined || fromModel.accent !== undefined)) {
      slots.accentText = contrastingText(slots.accent);
      matched[slot] = "(contrast) accent";
    } else if (slot === "headingFamily" && (exact.values.fontFamily !== undefined || fromModel.fontFamily !== undefined)) {
      slots.headingFamily = slots.fontFamily;
      matched[slot] = "(inherit) fontFamily";
    } else {
      defaulted.push(slot);
    }
  }

  return {
    slots,
    matched,
    defaulted,
    uncertain,
    usedModel,
    errors,
    hasDarkVariant: vars.some((v) => v.darkScope),
  };
}
