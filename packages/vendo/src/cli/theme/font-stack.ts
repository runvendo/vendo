/**
 * Deterministic body-font-stack derivation for the conventional setups the
 * exact `--font-sans` CSS read cannot see:
 *
 * - Tailwind v3: `theme(.extend).fontFamily.sans` in tailwind.config.* — an
 *   array whose head is usually a next/font CSS variable and whose tail
 *   spreads Tailwind's documented default stack.
 * - Tailwind v4 with no `--font-sans` override: the framework's default
 *   stack, headed by the single root-layout-applied next/font family.
 * - No Tailwind: a single font applied by next/font on the root layout IS
 *   the body font (next/font semantics), with no declared tail.
 *
 * Everything here reads documented conventions — next/font's "the import's
 * export name is the family" (underscores become spaces) and the geist
 * package's fixed variables — never inference: any entry it cannot resolve
 * aborts the whole derivation (null) and the slot stays with the staged
 * model pass.
 */

export interface FontBinding {
  /** CSS custom property the font is exposed as (next/font's `variable`
   *  option, or geist's fixed names); null when only `.className` exists. */
  variable: string | null;
  family: string;
  /** Referenced in the layout as `.className`/`.variable` — actually applied
   *  to markup, not merely imported. */
  applied: boolean;
}

/** Tailwind's default sans stack — identical in v3's
 *  `tailwindcss/defaultTheme` fontFamily.sans and v4's default `--font-sans`
 *  theme value (tailwindcss.com/docs/font-family). */
export const TAILWIND_DEFAULT_SANS: readonly string[] = [
  "ui-sans-serif",
  "system-ui",
  "sans-serif",
  "Apple Color Emoji",
  "Segoe UI Emoji",
  "Segoe UI Symbol",
  "Noto Color Emoji",
];

/** The geist package's two fonts: fixed export names, families, variables. */
const GEIST_FONTS = [
  { importName: "GeistSans", specifier: "geist/font/sans", family: "Geist Sans", variable: "--font-geist-sans" },
  { importName: "GeistMono", specifier: "geist/font/mono", family: "Geist Mono", variable: "--font-geist-mono" },
] as const;

/** Font bindings declared IN the given source (conventionally the root
 *  layout — fonts wired through a separate module are invisible here and the
 *  derivation simply doesn't fire, leaving the slot to the model pass). */
export function layoutFontBindings(source: string): FontBinding[] {
  const bindings: FontBinding[] = [];
  for (const font of GEIST_FONTS) {
    const imported = new RegExp(
      `import\\s*\\{[^}]*\\b${font.importName}\\b[^}]*\\}\\s*from\\s*["']${font.specifier}["']`,
    ).test(source);
    if (!imported) continue;
    const applied = new RegExp(`\\b${font.importName}\\.(?:variable|className)\\b`).test(source);
    bindings.push({ variable: font.variable, family: font.family, applied });
  }
  const googleImport = source.match(/import\s*\{([^}]*)\}\s*from\s*["']next\/font\/google["']/);
  for (const raw of (googleImport?.[1] ?? "").split(",")) {
    const importName = raw.trim();
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(importName)) continue;
    // const inter = Inter({ subsets: [...], variable: "--font-inter" })
    const call = source.match(
      new RegExp(`(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*${importName}\\s*\\(([\\s\\S]*?)\\)`),
    );
    const local = call?.[1];
    const variable = call?.[2]?.match(/variable\s*:\s*["'](--[\w-]+)["']/)?.[1] ?? null;
    const applied = local !== undefined && new RegExp(`\\b${local}\\.(?:variable|className)\\b`).test(source);
    bindings.push({ variable, family: importName.replace(/_/g, " "), applied });
  }
  return bindings;
}

/** ONLY the two real-world spellings of spreading Tailwind's own default
 *  sans: `...fontFamily.sans` (destructured from tailwindcss/defaultTheme)
 *  and `...defaultTheme.fontFamily.sans` (default import). Anything else —
 *  `...browserFonts.sans`, `...designSystem.fontFamily.sans` — is a custom
 *  expression whose contents are unknowable here and must fail CLOSED to
 *  the model stage, never map to the default stack. */
const DEFAULT_SANS_SPREAD = /^\.\.\.\s*(?:defaultTheme\.)?fontFamily\.sans$/;

/** A config's `fontFamily.sans` read has THREE outcomes, and the difference
 *  is load-bearing: `{ declared: false }` (no sans key — other derivation
 *  rules may apply), `{ declared: true, entries }` (parsed), and
 *  `{ declared: true, entries: null }` (a sans key exists but contains
 *  something unreadable, e.g. a custom spread — the config is authoritative
 *  and the derivation must fail CLOSED to the model stage, never fall
 *  through to a guess). */
export type TailwindSansRead =
  | { declared: false }
  | { declared: true; entries: string[] | null };

/** Entries of the config's `fontFamily.sans` array (Tailwind v3 shape).
 *  String literals stay verbatim, a spread of Tailwind's default sans
 *  expands to the documented stack, anything else is unreadable. */
export function tailwindConfigSansStack(config: string): TailwindSansRead {
  const fontFamily = config.match(/fontFamily\s*:\s*\{([\s\S]*?)\}/);
  const sans = fontFamily?.[1]?.match(/\bsans\s*:\s*\[([^\]]*)\]/);
  if (!sans) return { declared: false };
  const entries: string[] = [];
  for (const raw of sans[1]!.split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const literal = entry.match(/^(["'])(.*)\1$/);
    if (literal) {
      entries.push(literal[2]!);
      continue;
    }
    if (DEFAULT_SANS_SPREAD.test(entry)) {
      entries.push(...TAILWIND_DEFAULT_SANS);
      continue;
    }
    return { declared: true, entries: null };
  }
  return { declared: true, entries: entries.length > 0 ? entries : null };
}

export interface DerivedFontStack {
  /** Raw comma-joined stack — callers normalize (extract-theme's
   *  normalizeFontStack owns quoting/truncation canonicalization). */
  value: string;
  /** Provenance string for ThemeSummary.matched. */
  provenance: string;
}

/** Split a font stack on top-level commas — commas inside `var(--x, fb)`
 *  fallbacks stay within their entry. */
function splitStack(value: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      entries.push(current.trim());
      current = "";
    } else current += ch;
  }
  entries.push(current.trim());
  return entries.filter(Boolean);
}

export function deriveBodyFontStack(input: {
  layout: string | null;
  tailwindConfig: string | null;
  /** Concatenated gathered CSS — only used for the Tailwind v4 marker. */
  cssText: string;
  /** Resolve a CSS custom property from the gathered sheets (light scope). */
  resolveCssVar: (name: string) => string | null;
  /** Raw value of a CSS `--font-sans` declaration whose var() refs the exact
   *  read could not resolve from the sheets alone (next/font variables live
   *  in the layout, not the CSS). */
  cssFontSans?: string;
}): DerivedFontStack | null {
  const bindings = input.layout === null ? [] : layoutFontBindings(input.layout);
  const resolveEntry = (entry: string): string | null => {
    const varRef = entry.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/);
    if (varRef === null) return entry;
    const fromCss = input.resolveCssVar(varRef[1]!);
    if (fromCss !== null) return fromCss;
    const binding = bindings.find((candidate) => candidate.variable === varRef[1]);
    if (binding !== undefined) return binding.family;
    const fallback = varRef[2]?.trim();
    return fallback ? fallback : null;
  };

  // A declared `--font-sans` is the MOST authoritative source — when the
  // exact CSS read failed only because its var() refs are next/font
  // variables, resolve them through the layout's font bindings.
  if (input.cssFontSans !== undefined) {
    const resolved = splitStack(input.cssFontSans).map(resolveEntry);
    if (!resolved.every((entry): entry is string => entry !== null)) return null;
    return { value: resolved.join(", "), provenance: "--font-sans (next/font vars)" };
  }

  const configSans: TailwindSansRead = input.tailwindConfig === null
    ? { declared: false }
    : tailwindConfigSansStack(input.tailwindConfig);
  if (configSans.declared) {
    // The config is authoritative once it declares a sans stack: an
    // unreadable declaration (custom spread) or an unresolvable head fails
    // CLOSED to the model stage — never through to the binding guesses below.
    if (configSans.entries === null) return null;
    const resolved = configSans.entries.map(resolveEntry);
    if (!resolved.every((entry): entry is string => entry !== null)) return null;
    return { value: resolved.join(", "), provenance: "tailwind.config fontFamily.sans" };
  }

  const appliedSans = bindings.filter((binding) => binding.applied && !/\bmono\b/i.test(binding.family));
  if (appliedSans.length !== 1) return null;
  const family = appliedSans[0]!.family;
  if (/@import\s+["']tailwindcss["']/.test(input.cssText)) {
    return {
      value: [family, ...TAILWIND_DEFAULT_SANS].join(", "),
      provenance: `(next/font) ${family} + tailwindcss default sans`,
    };
  }
  return { value: family, provenance: `(next/font) ${family}` };
}
