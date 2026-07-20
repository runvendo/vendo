import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { contrastingText, normalizeColor, normalizeLength, resolveCssVarRefs } from "./color.js";
import { parseCssVars, type CssVarDecl } from "./css-vars.js";
import { ENTRY_FILE_CANDIDATES } from "./entry-candidates.js";
import { walk } from "./walk.js";

/**
 * Theme extraction, exact-then-staged (kill-list §B2, re-derived Task 2/4):
 *
 * 1. Allowlist fast-path — conventional shadcn/Tailwind tokens are read
 *    EXACTLY (`--primary`, `--background`, `--font-sans`, ... and their
 *    Tailwind-v4 `--color-*` spellings). No name scoring, no inference. This
 *    file does ONLY this: `extractTheme` is fully deterministic — no model
 *    call, no network, no credential.
 * 2. Whatever the allowlist leaves unfilled rides init's consent-gated AI
 *    pass (`runAiExtraction` → `runStagedExtraction`'s theme stage, in
 *    `../extract/stages.ts`) — the SAME harness seam as the tool-description
 *    polish, over Read/Glob/Grep instead of a fixed evidence-file set.
 *    `applyThemeDraft` below merges that stage's parsed artifact back onto
 *    this file's exact-only summary.
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
  /** Slots the exact allowlist pass did not read exactly — the staged theme
   *  pass's `needed` input, and the only slots `applyThemeDraft` may fill. */
  needed: SlotKey[];
  /** The CSS/layout/tailwind-config paths the context gatherer collected,
   *  repo-relative — seeded as evidence-path hints for the staged pass. */
  evidencePaths: string[];
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

function evidencePathsOf(context: ThemeContext): string[] {
  return [
    ...(context.layout ? [context.layout.path] : []),
    ...context.css.map((file) => file.path),
    ...(context.tailwindConfig ? [context.tailwindConfig.path] : []),
  ];
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
// Staged-pass artifact schema — parsed by `runStagedExtraction`'s theme stage
// (../extract/stages.ts), merged back here by `applyThemeDraft`.
// ---------------------------------------------------------------------------

/** Brand-defining slots: any of these missing after the exact pass triggers
 *  the staged theme pass, and only doubt about these becomes an init
 *  question. The remaining slots (accentText, headingFamily, baseSize,
 *  density, motion) derive or default safely — accentText derives from the
 *  accent by WCAG contrast, headingFamily inherits fontFamily, and the rest
 *  have safe brand-neutral defaults — so they never trigger a call or a
 *  question on their own. */
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
// Assembly — ONE shared precedence loop used both by extractTheme's
// exact-only pass (fromModel = {}) and applyThemeDraft's merge.
// ---------------------------------------------------------------------------

interface AssembledTheme {
  slots: ThemeSlotValues;
  matched: Record<string, string>;
  defaulted: string[];
}

function assembleTheme(
  values: Partial<ThemeSlotValues>,
  matchedExact: Record<string, string>,
  fromModel: Partial<Record<SlotKey, string>>,
): AssembledTheme {
  const slots = { ...DEFAULT_THEME_SLOTS };
  const matched: Record<string, string> = {};
  const defaulted: string[] = [];
  for (const slot of SLOT_KEYS) {
    const exactValue = values[slot];
    const modelValue = fromModel[slot];
    if (exactValue !== undefined) {
      (slots as Record<string, unknown>)[slot] = exactValue;
      matched[slot] = matchedExact[slot]!;
    } else if (modelValue !== undefined) {
      (slots as Record<string, unknown>)[slot] = modelValue;
      matched[slot] = "(model)";
    } else if (slot === "accentText" && (values.accent !== undefined || fromModel.accent !== undefined)) {
      slots.accentText = contrastingText(slots.accent);
      matched[slot] = "(contrast) accent";
    } else if (slot === "headingFamily" && (values.fontFamily !== undefined || fromModel.fontFamily !== undefined)) {
      slots.headingFamily = slots.fontFamily;
      matched[slot] = "(inherit) fontFamily";
    } else {
      defaulted.push(slot);
    }
  }
  return { slots, matched, defaulted };
}

// ---------------------------------------------------------------------------
// Exact-only extraction
// ---------------------------------------------------------------------------

export async function extractTheme(targetDir: string): Promise<ThemeSummary> {
  const context = await gatherContext(targetDir);
  const vars: CssVarDecl[] = context.css.flatMap((file) => parseCssVars(file.content, file.path));
  const exact = readExact(vars);
  const needed = SLOT_KEYS.filter((slot) => exact.values[slot] === undefined);
  const { slots, matched, defaulted } = assembleTheme(exact.values, exact.matched, {});

  return {
    slots,
    matched,
    defaulted,
    uncertain: [],
    usedModel: false,
    errors: [],
    hasDarkVariant: vars.some((v) => v.darkScope),
    needed,
    evidencePaths: evidencePathsOf(context),
  };
}

/**
 * Merges a parsed theme-stage artifact (`modelThemeSchema`) onto an
 * exact-only `ThemeSummary` — the precedence law (kill-list §B2, Task 2):
 * exact reads are never overwritten; only `needed` slots may be filled; every
 * proposed value passes through `validateSlotValue` (invalid values are
 * ignored, the slot stays defaulted/derived); a model-provided accentText
 * stands; accentText re-derives by contrast only when the model filled
 * accent but not accentText and accentText itself wasn't an exact read;
 * headingFamily inherits fontFamily under the mirror condition.
 */
export function applyThemeDraft(
  summary: ThemeSummary,
  draft: z.infer<typeof modelThemeSchema>,
): ThemeSummary {
  const neededSet = new Set(summary.needed);
  const fromModel: Partial<Record<SlotKey, string>> = {};
  for (const slot of summary.needed) {
    const raw = draft.slots[slot];
    if (raw === undefined) continue;
    const value = validateSlotValue(slot, String(raw));
    if (value !== null) fromModel[slot] = value;
  }

  // Reconstruct the "already exact" values/provenance: everything NOT in
  // `needed` was an exact read (or, for a re-applied summary, already
  // settled) and must never be reconsidered here.
  const exactValues: Partial<ThemeSlotValues> = {};
  const exactMatched: Record<string, string> = {};
  for (const slot of SLOT_KEYS) {
    if (!neededSet.has(slot)) {
      (exactValues as Record<string, unknown>)[slot] = summary.slots[slot];
      exactMatched[slot] = summary.matched[slot]!;
    }
  }

  const { slots, matched, defaulted } = assembleTheme(exactValues, exactMatched, fromModel);
  const usedModel = Object.keys(fromModel).length > 0;
  const uncertain = (draft.uncertain ?? [])
    .filter((entry): entry is ThemeUncertainty => (BRAND_SLOTS as string[]).includes(entry.slot))
    .filter((entry) => neededSet.has(entry.slot as SlotKey));

  return {
    ...summary,
    slots,
    matched,
    defaulted,
    uncertain,
    usedModel,
  };
}
