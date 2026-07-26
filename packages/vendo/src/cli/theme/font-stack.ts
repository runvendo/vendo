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
 * All source analysis is TypeScript-AST structure matching (never substring
 * scans): import provenance is resolved to its module specifier, a spread of
 * Tailwind's default sans counts only when its binding provably comes from
 * "tailwindcss/defaultTheme", and a font is "applied" only when its
 * `.className`/`.variable` reference is attached to a JSX attribute on a
 * rendered element. Anything unprovable — including an unavailable compiler
 * — fails CLOSED to the staged model pass.
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

interface ParsedModule {
  ts: typeof TS;
  sf: TS.SourceFile;
}

function parseModuleSource(source: string, fileName: string): ParsedModule | null {
  const ts = loadCompiler();
  if (!ts) return null;
  const kind = /\.[cm]?ts$/u.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.TSX;
  return { ts, sf: ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind) };
}

function visitNodes(ts: typeof TS, root: TS.Node, visit: (node: TS.Node) => void): void {
  const walkNode = (node: TS.Node): void => {
    visit(node);
    ts.forEachChild(node, walkNode);
  };
  ts.forEachChild(root, walkNode);
}

/** Every name a binding pattern introduces (destructuring included). */
function bindingNames(ts: typeof TS, name: TS.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) names.push(...bindingNames(ts, element.name));
  }
  return names;
}

/** Whether this SCOPE-CREATING node itself introduces `name`. */
function scopeDeclares(ts: typeof TS, scope: TS.Node, name: string): boolean {
  if (ts.isFunctionLike(scope)) {
    for (const parameter of scope.parameters) {
      if (ts.isParameter(parameter) && bindingNames(ts, parameter.name).includes(name)) return true;
    }
  }
  const statements = ts.isBlock(scope) || ts.isModuleBlock(scope) ? scope.statements : null;
  if (statements !== null) {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (bindingNames(ts, declaration.name).includes(name)) return true;
        }
      }
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) {
        return true;
      }
    }
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration !== undefined
    && bindingNames(ts, scope.variableDeclaration.name).includes(name)) return true;
  if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope))
    && scope.initializer !== undefined && ts.isVariableDeclarationList(scope.initializer)) {
    for (const declaration of scope.initializer.declarations) {
      if (bindingNames(ts, declaration.name).includes(name)) return true;
    }
  }
  return false;
}

/** Whether this FILE-scope statement introduces `name` (imports included). */
function statementDeclares(ts: typeof TS, statement: TS.Statement, name: string): boolean {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause?.name?.text === name) return true;
    const bindings = clause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) return bindings.name.text === name;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      return bindings.elements.some((element) => element.name.text === name);
    }
    return false;
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some((declaration) => bindingNames(ts, declaration.name).includes(name));
  }
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) return true;
  return false;
}

/** Scope-aware, checker-free binding resolution: true when the identifier
 * USE resolves to the given top-level declaration statement — no scope
 * between the use and the file scope shadows the name, and the first
 * file-scope statement declaring it IS `declaration`. A shadowed name fails
 * to resolve, so font evidence fails CLOSED. */
function resolvesToDeclaration(ts: typeof TS, use: TS.Identifier, declaration: TS.Statement): boolean {
  const name = use.text;
  for (let node: TS.Node | undefined = use.parent; node !== undefined; node = node.parent) {
    if (ts.isSourceFile(node)) {
      for (const statement of node.statements) {
        if (statementDeclares(ts, statement, name)) return statement === declaration;
      }
      return false;
    }
    if (scopeDeclares(ts, node, name)) return false;
  }
  return false;
}

export interface FontBinding {
  /** CSS custom property the font is exposed as (next/font's `variable`
   *  option, or geist's fixed names); null when only `.className` exists. */
  variable: string | null;
  family: string;
  /** The local's `.className`/`.variable` is attached to a JSX attribute on
   *  a rendered element — actually applied to markup, not merely imported,
   *  configured, or referenced in dead code. */
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
  statement: TS.Statement;
}

/** Named-import locals for `imported` from `specifier` (aliases resolved),
 *  with their declaring import statement for symbol resolution. */
function namedImportLocals(parsed: ParsedModule, specifier: string, imported: string): NamedImportLocal[] {
  const { ts, sf } = parsed;
  const locals: NamedImportLocal[] = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== specifier) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === imported) {
        locals.push({ local: element.name.text, statement });
      }
    }
  }
  return locals;
}

/** True when `local.className` / `local.variable` appears inside a JSX
 *  attribute (including spread attributes) of a rendered element AND the
 *  reference resolves (scope-aware) to `declaration` — template literals and
 *  cn(...) calls inside the attribute count; a reference parked in a dead
 *  constant, or one whose name is SHADOWED by a nearer declaration, does
 *  not. */
function appliedToJsx(parsed: ParsedModule, local: string, declaration: TS.Statement): boolean {
  const { ts, sf } = parsed;
  let applied = false;
  visitNodes(ts, sf, (node) => {
    if (applied) return;
    if (!ts.isPropertyAccessExpression(node)) return;
    if (!ts.isIdentifier(node.expression) || node.expression.text !== local) return;
    if (node.name.text !== "className" && node.name.text !== "variable") return;
    if (!resolvesToDeclaration(ts, node.expression, declaration)) return;
    for (let ancestor: TS.Node | undefined = node.parent; ancestor !== undefined; ancestor = ancestor.parent) {
      if (ts.isJsxAttribute(ancestor) || ts.isJsxSpreadAttribute(ancestor)) {
        applied = true;
        return;
      }
    }
  });
  return applied;
}

/** Font bindings declared IN the given source (conventionally the root
 *  layout — fonts wired through a separate module are invisible here and the
 *  derivation simply doesn't fire, leaving the slot to the model pass). */
export function layoutFontBindings(source: string): FontBinding[] {
  const parsed = parseModuleSource(source, "layout.tsx");
  if (parsed === null) return [];
  const { ts, sf } = parsed;
  const bindings: FontBinding[] = [];

  for (const font of GEIST_FONTS) {
    for (const { local, statement } of namedImportLocals(parsed, font.specifier, font.importName)) {
      bindings.push({ variable: font.variable, family: font.family, applied: appliedToJsx(parsed, local, statement) });
    }
  }

  // next/font/google: `import { Some_Font } from "next/font/google"` +
  // `const someFont = Some_Font({ ..., variable: "--font-x" })` — the export
  // name is the family (underscores become spaces).
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "next/font/google") continue;
    const named = statement.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      const family = (element.propertyName ?? element.name).text.replace(/_/g, " ");
      const importedLocal = element.name.text;
      let variable: string | null = null;
      let fontLocal: string | null = null;
      let fontStatement: TS.Statement | null = null;
      // The font local is only usable for symbol resolution when declared at
      // file scope (the universal layout shape); a nested declaration cannot
      // be resolved and fails closed to the model.
      for (const declStatement of sf.statements) {
        if (fontLocal !== null) break;
        if (!ts.isVariableStatement(declStatement)) continue;
        for (const node of declStatement.declarationList.declarations) {
          if (!ts.isIdentifier(node.name)) continue;
          const init = node.initializer;
          if (init === undefined || !ts.isCallExpression(init)) continue;
          if (!ts.isIdentifier(init.expression) || init.expression.text !== importedLocal) continue;
          fontLocal = node.name.text;
          fontStatement = declStatement;
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
        applied: fontLocal !== null && fontStatement !== null && appliedToJsx(parsed, fontLocal, fontStatement),
      });
    }
  }
  return bindings;
}

/** A config's `fontFamily.sans` read has THREE outcomes, and the difference
 *  is load-bearing: `{ declared: false }` (no sans key — other derivation
 *  rules may apply), `{ declared: true, entries }` (parsed), and
 *  `{ declared: true, entries: null }` (a sans key exists but contains
 *  something unprovable — the config is authoritative and the derivation
 *  must fail CLOSED to the model stage, never fall through to a guess). */
export type TailwindSansRead =
  | { declared: false }
  | { declared: true; entries: string[] | null };

/** Locals provably bound to "tailwindcss/defaultTheme": either its
 *  `fontFamily` member directly (named import / destructured require) or the
 *  whole module object (default/namespace import, bare require). */
interface DefaultThemeBinding {
  local: string;
  binds: "fontFamily" | "module";
}

function defaultThemeBindings(parsed: ParsedModule): DefaultThemeBinding[] {
  const { ts, sf } = parsed;
  const out: DefaultThemeBinding[] = [];
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === "tailwindcss/defaultTheme") {
      const clause = statement.importClause;
      if (clause?.name !== undefined) out.push({ local: clause.name.text, binds: "module" });
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) out.push({ local: bindings.name.text, binds: "module" });
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === "fontFamily") {
            out.push({ local: element.name.text, binds: "fontFamily" });
          }
        }
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const init = declaration.initializer;
      if (init === undefined || !ts.isCallExpression(init)) continue;
      if (!ts.isIdentifier(init.expression) || init.expression.text !== "require") continue;
      const argument = init.arguments[0];
      if (argument === undefined || !ts.isStringLiteralLike(argument) || argument.text !== "tailwindcss/defaultTheme") continue;
      if (ts.isIdentifier(declaration.name)) out.push({ local: declaration.name.text, binds: "module" });
      if (ts.isObjectBindingPattern(declaration.name)) {
        for (const element of declaration.name.elements) {
          if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
          const imported = element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text;
          if (imported === "fontFamily") out.push({ local: element.name.text, binds: "fontFamily" });
        }
      }
    }
  }
  return out;
}

/** The spread expression is provably Tailwind's own default sans:
 *  `<fontFamilyLocal>.sans` or `<moduleLocal>.fontFamily.sans`, where the
 *  root binding demonstrably comes from "tailwindcss/defaultTheme". A local
 *  object that merely SPELLS the same path never matches. */
function isDefaultSansSpread(parsed: ParsedModule, expression: TS.Expression, bindings: DefaultThemeBinding[]): boolean {
  const { ts } = parsed;
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "sans") return false;
  const base = expression.expression;
  if (ts.isIdentifier(base)) {
    return bindings.some((binding) => binding.binds === "fontFamily" && binding.local === base.text);
  }
  if (ts.isPropertyAccessExpression(base) && base.name.text === "fontFamily" && ts.isIdentifier(base.expression)) {
    const root = base.expression.text;
    return bindings.some((binding) => binding.binds === "module" && binding.local === root);
  }
  return false;
}

/** Entries of the config's `fontFamily.sans` array (Tailwind v3 shape),
 *  located structurally: a `fontFamily` object property anywhere in the
 *  config (theme or theme.extend) holding a `sans` array. String literals
 *  stay verbatim; a spread counts as Tailwind's default stack only with
 *  proven "tailwindcss/defaultTheme" provenance; anything else is
 *  unreadable. */
export function tailwindConfigSansStack(config: string): TailwindSansRead {
  const parsed = parseModuleSource(config, "tailwind.config.ts");
  if (parsed === null) return { declared: false };
  const { ts, sf } = parsed;
  const provenance = defaultThemeBindings(parsed);

  let sansArray: TS.ArrayLiteralExpression | null = null;
  visitNodes(ts, sf, (node) => {
    if (sansArray !== null) return;
    if (!ts.isPropertyAssignment(node)) return;
    const name = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : null;
    if (name !== "fontFamily" || !ts.isObjectLiteralExpression(node.initializer)) return;
    for (const property of node.initializer.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : null;
      if (key === "sans" && ts.isArrayLiteralExpression(property.initializer)) {
        sansArray = property.initializer;
        return;
      }
    }
  });
  if (sansArray === null) return { declared: false };

  const entries: string[] = [];
  for (const element of (sansArray as TS.ArrayLiteralExpression).elements) {
    if (parsed.ts.isStringLiteralLike(element)) {
      entries.push(element.text);
      continue;
    }
    if (parsed.ts.isSpreadElement(element) && isDefaultSansSpread(parsed, element.expression, provenance)) {
      entries.push(...TAILWIND_DEFAULT_SANS);
      continue;
    }
    return { declared: true, entries: null };
  }
  return { declared: true, entries: entries.length > 0 ? entries : null };
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
