import { createRequire } from "node:module";
import type TS from "typescript";

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
 * All source analysis rides a real single-file ts.Program and TypeScript's
 * own binder (TypeChecker symbol resolution) — never name matching: a spread
 * expands to Tailwind's default stack only when its binding's SYMBOL declares
 * from "tailwindcss/defaultTheme"; a font is "applied" only when the JSX
 * reference's symbol IS the font's declaration; the config's sans array is
 * located through the exported config object, never by scanning for a
 * `fontFamily` key anywhere in the file. Anything unprovable — including an
 * unavailable compiler — fails CLOSED to the staged model pass.
 *
 * Precision boundary (Yousef ruling 2026-07-26): symbol-correct import +
 * direct JSX usage is the required depth. Documented limitations, out of
 * scope by ruling (each fails closed to the model rather than guessing):
 * - fonts referenced only via non-class JSX attributes (e.g. a style prop
 *   carrying the variable) are not counted as applied;
 * - a tailwind-config font stack whose head font is configured but never
 *   applied in the layout is trusted as declared (no render-graph check);
 * - require() provenance shadowed through re-exported/aliased intermediate
 *   modules is not chased past the one declaring statement.
 */

// The TypeScript compiler, resolved lazily through this package's own
// dependency graph (same posture as @vendoai/actions' loadCompiler): a Next
// host always carries typescript; when it genuinely cannot be loaded, every
// derivation here verifies nothing and the slot stays with the model.
let compilerModule: typeof TS | null | undefined;

function loadCompiler(): typeof TS | null {
  if (compilerModule === undefined) {
    try {
      compilerModule = createRequire(import.meta.url)("typescript") as typeof TS;
    } catch {
      compilerModule = null;
    }
  }
  return compilerModule;
}

interface BoundModule {
  ts: typeof TS;
  sf: TS.SourceFile;
  checker: TS.TypeChecker;
}

/** A real single-file ts.Program (noResolve, in-memory host): symbol
 * resolution rides the compiler's binder. Imports stay unresolved on
 * purpose — an identifier's symbol still declares AT its ImportSpecifier,
 * which carries all the provenance needed. */
function boundModule(source: string, fileName: string): BoundModule | null {
  const ts = loadCompiler();
  if (!ts) return null;
  const kind = /\.[cm]?ts$/u.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const options: TS.CompilerOptions = {
    allowJs: true,
    noResolve: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    types: [],
  };
  const host: TS.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName,
    readFile: () => undefined,
  };
  const program = ts.createProgram({ rootNames: [fileName], options, host });
  const bound = program.getSourceFile(fileName);
  if (bound === undefined) return null;
  return { ts, sf: bound, checker: program.getTypeChecker() };
}

function declarationOf(mod: BoundModule, node: TS.Node): TS.Declaration | undefined {
  const symbol = mod.checker.getSymbolAtLocation(node);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

function unwrapExpression(ts: typeof TS, expression: TS.Expression): TS.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

export interface FontBinding {
  /** CSS custom property the font is exposed as (next/font's `variable`
   *  option, or geist's fixed names); null when only `.className` exists. */
  variable: string | null;
  family: string;
  /** The font's `.className`/`.variable` is attached to a JSX attribute AND
   *  the reference's SYMBOL is the font's own declaration — actually applied
   *  to markup, not merely imported, configured, referenced in dead code, or
   *  shadowed. */
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

interface NamedImportLocal {
  local: string;
  /** The ImportSpecifier node — the symbol-comparison anchor. */
  declaration: TS.ImportSpecifier;
}

function namedImportLocals(mod: BoundModule, specifier: string, imported: string): NamedImportLocal[] {
  const { ts, sf } = mod;
  const locals: NamedImportLocal[] = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== specifier) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === imported) {
        locals.push({ local: element.name.text, declaration: element });
      }
    }
  }
  return locals;
}

/** True when `local.className` / `local.variable` sits inside a JSX
 *  attribute (spread attributes, template literals, cn(...) calls all count)
 *  AND the identifier's SYMBOL declares at `declaration` — dead constants
 *  and every shadowing shape (parameters, locals, hoisted vars) resolve to
 *  other symbols and never count. */
function appliedToJsx(mod: BoundModule, local: string, declaration: TS.Declaration): boolean {
  const { ts, sf } = mod;
  let applied = false;
  const visit = (node: TS.Node): void => {
    if (applied) return;
    if (ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === local
      && (node.name.text === "className" || node.name.text === "variable")
      && declarationOf(mod, node.expression) === declaration) {
      for (let ancestor: TS.Node | undefined = node.parent; ancestor !== undefined; ancestor = ancestor.parent) {
        if (ts.isJsxAttribute(ancestor) || ts.isJsxSpreadAttribute(ancestor)) {
          applied = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return applied;
}

/** Font bindings declared IN the given source (conventionally the root
 *  layout — fonts wired through a separate module are invisible here and the
 *  derivation simply doesn't fire, leaving the slot to the model pass). */
export function layoutFontBindings(source: string): FontBinding[] {
  const mod = boundModule(source, "layout.tsx");
  if (mod === null) return [];
  const { ts, sf } = mod;
  const bindings: FontBinding[] = [];

  for (const font of GEIST_FONTS) {
    for (const { local, declaration } of namedImportLocals(mod, font.specifier, font.importName)) {
      bindings.push({ variable: font.variable, family: font.family, applied: appliedToJsx(mod, local, declaration) });
    }
  }

  // next/font/google: `import { Some_Font } from "next/font/google"` +
  // `const someFont = Some_Font({ ..., variable: "--font-x" })` — the export
  // name is the family (underscores become spaces). The factory callee is
  // symbol-verified against the import; the font local must be a file-scope
  // declaration (the universal layout shape) or nothing derives.
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "next/font/google") continue;
    const named = statement.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      const family = (element.propertyName ?? element.name).text.replace(/_/g, " ");
      let variable: string | null = null;
      let fontLocal: string | null = null;
      let fontDeclaration: TS.Declaration | null = null;
      for (const declStatement of sf.statements) {
        if (fontLocal !== null) break;
        if (!ts.isVariableStatement(declStatement)) continue;
        for (const node of declStatement.declarationList.declarations) {
          if (!ts.isIdentifier(node.name)) continue;
          const init = node.initializer;
          if (init === undefined || !ts.isCallExpression(init)) continue;
          if (!ts.isIdentifier(init.expression)) continue;
          // Symbol-verified: the callee must BE this import binding.
          if (declarationOf(mod, init.expression) !== element) continue;
          fontLocal = node.name.text;
          fontDeclaration = node;
          const options = init.arguments[0];
          if (options !== undefined && ts.isObjectLiteralExpression(options)) {
            for (const property of options.properties) {
              if (!ts.isPropertyAssignment(property)) continue;
              const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
              if (name === "variable" && ts.isStringLiteralLike(property.initializer)) {
                variable = property.initializer.text;
              }
            }
          }
          break;
        }
      }
      bindings.push({
        variable,
        family,
        applied: fontLocal !== null && fontDeclaration !== null && appliedToJsx(mod, fontLocal, fontDeclaration),
      });
    }
  }
  return bindings;
}

/** A config's `fontFamily.sans` read has THREE outcomes, and the difference
 *  is load-bearing: `{ declared: false }` (the located config declares no
 *  sans — other derivation rules may apply), `{ declared: true, entries }`
 *  (parsed), and `{ declared: true, entries: null }` (a config exists but
 *  its sans — or the config object itself — is unprovable: authoritative,
 *  fail CLOSED to the model stage, never fall through to a guess). */
export type TailwindSansRead =
  | { declared: false }
  | { declared: true; entries: string[] | null };

/** The spread's symbol provably declares from "tailwindcss/defaultTheme":
 *  `<fontFamily>.sans` where the identifier's declaration is that module's
 *  named import (aliased ok) or a binding element destructured from
 *  `require("tailwindcss/defaultTheme")`; or `<mod>.fontFamily.sans` where
 *  the root's declaration is a default/namespace import or bare require of
 *  that module. A local that merely SPELLS the same path resolves to its own
 *  declaration and never matches. */
function isDefaultSansSpread(mod: BoundModule, expression: TS.Expression): boolean {
  const { ts } = mod;
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "sans") return false;
  const base = expression.expression;
  if (ts.isIdentifier(base)) {
    const declaration = declarationOf(mod, base);
    if (declaration === undefined) return false;
    if (ts.isImportSpecifier(declaration)) {
      const importDeclaration = declaration.parent.parent.parent;
      return ts.isImportDeclaration(importDeclaration)
        && ts.isStringLiteral(importDeclaration.moduleSpecifier)
        && importDeclaration.moduleSpecifier.text === "tailwindcss/defaultTheme"
        && (declaration.propertyName ?? declaration.name).text === "fontFamily";
    }
    if (ts.isBindingElement(declaration)) {
      const imported = declaration.propertyName !== undefined && ts.isIdentifier(declaration.propertyName)
        ? declaration.propertyName.text
        : ts.isIdentifier(declaration.name) ? declaration.name.text : null;
      if (imported !== "fontFamily") return false;
      const variableDeclaration = declaration.parent.parent;
      return ts.isVariableDeclaration(variableDeclaration) && isRequireOfDefaultTheme(mod, variableDeclaration.initializer);
    }
    return false;
  }
  if (ts.isPropertyAccessExpression(base) && base.name.text === "fontFamily" && ts.isIdentifier(base.expression)) {
    const declaration = declarationOf(mod, base.expression);
    if (declaration === undefined) return false;
    if (ts.isImportClause(declaration) && ts.isImportDeclaration(declaration.parent)
      && ts.isStringLiteral(declaration.parent.moduleSpecifier)) {
      return declaration.parent.moduleSpecifier.text === "tailwindcss/defaultTheme";
    }
    if (ts.isNamespaceImport(declaration)) {
      const importDeclaration = declaration.parent.parent;
      return ts.isImportDeclaration(importDeclaration)
        && ts.isStringLiteral(importDeclaration.moduleSpecifier)
        && importDeclaration.moduleSpecifier.text === "tailwindcss/defaultTheme";
    }
    if (ts.isVariableDeclaration(declaration)) return isRequireOfDefaultTheme(mod, declaration.initializer);
    return false;
  }
  return false;
}

function isRequireOfDefaultTheme(mod: BoundModule, initializer: TS.Expression | undefined): boolean {
  const { ts } = mod;
  if (initializer === undefined) return false;
  const call = unwrapExpression(ts, initializer);
  return ts.isCallExpression(call)
    && ts.isIdentifier(call.expression)
    && call.expression.text === "require"
    && call.arguments.length > 0
    && ts.isStringLiteralLike(call.arguments[0]!)
    && (call.arguments[0] as TS.StringLiteralLike).text === "tailwindcss/defaultTheme";
}

/** A named object-literal property's value, following ONE identifier hop
 *  through the checker to a file-scope const initializer. */
function propertyValue(mod: BoundModule, object: TS.ObjectLiteralExpression, name: string): TS.Expression | null {
  const { ts } = mod;
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)) {
      const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : null;
      if (key === name) return unwrapExpression(ts, property.initializer);
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
      const declaration = declarationOf(mod, property.name);
      if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
        return unwrapExpression(ts, declaration.initializer);
      }
      return null;
    }
  }
  return null;
}

/** The exported config object: `export default X` or `module.exports = X`,
 *  where X is an object literal, an identifier resolving (checker) to a
 *  const object literal, or a call whose single object-literal argument IS
 *  the config (defineConfig/withPlugins shapes). Null = unlocatable. */
function exportedConfigObject(mod: BoundModule): TS.ObjectLiteralExpression | null {
  const { ts, sf } = mod;
  let expression: TS.Expression | null = null;
  for (const statement of sf.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      expression = statement.expression;
      break;
    }
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
      && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = statement.expression.left;
      if (ts.isPropertyAccessExpression(target)
        && ts.isIdentifier(target.expression) && target.expression.text === "module"
        && target.name.text === "exports") {
        expression = statement.expression.right;
        break;
      }
    }
  }
  if (expression === null) return null;
  let value = unwrapExpression(ts, expression);
  if (ts.isIdentifier(value)) {
    const declaration = declarationOf(mod, value);
    if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return null;
    value = unwrapExpression(ts, declaration.initializer);
  }
  if (ts.isCallExpression(value) && value.arguments.length === 1) {
    const argument = unwrapExpression(ts, value.arguments[0]!);
    if (ts.isObjectLiteralExpression(argument)) return argument;
    return null;
  }
  return ts.isObjectLiteralExpression(value) ? value : null;
}

/** The config's sans array, located STRUCTURALLY through the exported config
 *  object only — config root (theme fragment files), `theme.fontFamily`, or
 *  `theme.extend.fontFamily`. An unrelated object elsewhere in the file that
 *  happens to carry a fontFamily key is never read. */
export function tailwindConfigSansStack(config: string): TailwindSansRead {
  const mod = boundModule(config, "tailwind.config.ts");
  // A config file exists but cannot be analyzed: authoritative → fail closed.
  if (mod === null) return { declared: true, entries: null };
  const { ts } = mod;
  const configObject = exportedConfigObject(mod);
  if (configObject === null) return { declared: true, entries: null };

  const fontFamilyCandidates: TS.Expression[] = [];
  const rootFontFamily = propertyValue(mod, configObject, "fontFamily");
  if (rootFontFamily !== null) fontFamilyCandidates.push(rootFontFamily);
  const theme = propertyValue(mod, configObject, "theme");
  if (theme !== null && ts.isObjectLiteralExpression(theme)) {
    const themeFontFamily = propertyValue(mod, theme, "fontFamily");
    if (themeFontFamily !== null) fontFamilyCandidates.push(themeFontFamily);
    const extend = propertyValue(mod, theme, "extend");
    if (extend !== null && ts.isObjectLiteralExpression(extend)) {
      const extendFontFamily = propertyValue(mod, extend, "fontFamily");
      if (extendFontFamily !== null) fontFamilyCandidates.push(extendFontFamily);
    }
  }
  if (fontFamilyCandidates.length === 0) return { declared: false };

  for (const candidate of fontFamilyCandidates) {
    // A fontFamily whose value we cannot read (a call, an unresolvable
    // identifier) is a declaration we must respect: fail closed.
    if (!ts.isObjectLiteralExpression(candidate)) return { declared: true, entries: null };
    const sans = propertyValue(mod, candidate, "sans");
    if (sans === null) continue;
    if (!ts.isArrayLiteralExpression(sans)) return { declared: true, entries: null };
    const entries: string[] = [];
    for (const element of sans.elements) {
      if (ts.isStringLiteralLike(element)) {
        entries.push(element.text);
        continue;
      }
      if (ts.isSpreadElement(element) && isDefaultSansSpread(mod, unwrapExpression(ts, element.expression))) {
        entries.push(...TAILWIND_DEFAULT_SANS);
        continue;
      }
      return { declared: true, entries: null };
    }
    return { declared: true, entries: entries.length > 0 ? entries : null };
  }
  return { declared: false };
}

export interface DerivedFontStack {
  /** Raw comma-joined stack — callers normalize (extract-theme's
   *  normalizeFontStack owns quoting canonicalization). */
  value: string;
  /** Provenance string for ThemeSummary.matched. */
  provenance: string;
}

/** Split a font stack on top-level commas — commas inside `var(--x, fb)`
 *  fallbacks stay within their entry. (CSS value text, not JS: this is the
 *  one place string handling is the correct domain.) */
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
    // unreadable declaration or an unresolvable head fails CLOSED to the
    // model stage — never through to the binding guesses below.
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
