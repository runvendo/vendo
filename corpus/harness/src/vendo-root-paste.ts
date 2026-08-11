import { writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { findClientMount, isPageComponentElement, mountedChild } from "./layers/structural.js";
import { readOptional } from "./util.js";

export interface VendoRootPasteResult {
  applied: boolean;
  file: string | null;
  reason: string;
}

const IMPORT_LINE = 'import { VendoProvider } from "@vendoai/vendo/react";';
// Theme-less on purpose: a `import theme from "../vendo/theme"` line would make
// every corpus host's tsconfig need resolveJsonModule. Layer 2 scores the theme
// from .vendo/theme.json on disk, never from the mount.
const PROVIDER_OPEN = '<VendoProvider baseUrl="/api/vendo">';
const PROVIDER_CLOSE = "</VendoProvider>";
const WRAP_EXPRESSION = `${PROVIDER_OPEN}{children}${PROVIDER_CLOSE}`;
// A module directive prologue line ('use client', "use strict", ...),
// optionally carrying a trailing comment. Pasted imports must land AFTER it:
// a directive preceded by an import is a no-op string literal, silently
// demoting a client layout to a server component (corpus-triage review
// finding: cubic P1; trailing comments + comment prefixes from the PR #441
// review round).
const DIRECTIVE_LINE = /^\s*(['"])use [a-z][a-z0-9 -]*\1;?\s*(?:\/\/.*|\/\*.*\*\/\s*)?$/;

/** Index of the first line AFTER the module's directive prologue (0 when the
 * file has none) — directives sit at the top, possibly preceded or separated
 * by blank lines and comments (a license header before 'use client' is still
 * a valid prologue), and end at the first line of real code. */
function directivePrologueEnd(lines: readonly string[]): number {
  let end = 0;
  let inBlockComment = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (line === "" || line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlockComment = true;
      continue;
    }
    if (!DIRECTIVE_LINE.test(line)) break;
    end = index + 1;
  }
  return end;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let inner = node;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner)) {
    inner = inner.expression;
  }
  return inner;
}

/** The module-level function declared as `name`, if it is one. */
function localFunction(sf: ts.SourceFile, name: string): ts.Node | undefined {
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
    }
  }
  return undefined;
}

/** The component behind an `export default` expression: the function itself, a
 * name pointing at one, or — teable's shape — a component handed to an HOC
 * (`export default appWithTranslation(MyApp, …)`). */
function componentOf(sf: ts.SourceFile, expression: ts.Expression): ts.Node | undefined {
  const inner = unwrapExpression(expression);
  if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return inner;
  if (ts.isIdentifier(inner)) return localFunction(sf, inner.text);
  if (ts.isCallExpression(inner)) {
    for (const argument of inner.arguments) {
      const component = componentOf(sf, argument);
      if (component !== undefined) return component;
    }
  }
  return undefined;
}

/** The module's DEFAULT EXPORT — the component Next actually renders — or null
 * when it cannot be resolved inside this file (a re-export, an HOC over an
 * imported component). Null fails the paste loudly; it deliberately does NOT
 * fall back to searching the module, because searching the module IS the bug:
 * a helper that renders `{children}` ABOVE the root layout won on first-match,
 * so the paste wrapped the helper, reported success, and left the page with no
 * reachable provider (Greptile, PR #1126). */
function defaultExportedComponent(sf: ts.SourceFile): ts.Node | null {
  for (const statement of sf.statements) {
    const isDefault = ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    if (isDefault && (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))) return statement;
    if (ts.isExportAssignment(statement) && statement.isExportEquals !== true) {
      return componentOf(sf, statement.expression) ?? null;
    }
  }
  return null;
}

/** The text span the mount wraps, searched inside the DEFAULT-EXPORTED
 * component only.
 * In an app-router layout: the JSX `{children}` it renders, or — for a
 * pass-through root layout that just `return children` (invoify keeps one only
 * because a sibling not-found.tsx demands it) — the returned identifier. Both
 * become the same wrap.
 * A `{ children }` DESTRUCTURING PARAMETER is neither, and only the parse can
 * say so: scanning for the last `{children}` in the file pasted JSX into
 * invoify's parameter list, because its parameter is the file's only match.
 * In a pages `_app`: the `<Component {...pageProps} …/>` element it renders,
 * whatever else it sits inside (teable's is an argument to `getLayout(…)`). */
function mountSpan(source: string, fileName: string, router: "app" | "pages"): { start: number; end: number } | null {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const isChildren = (node: ts.Node | undefined): boolean =>
    node !== undefined && ts.isIdentifier(node) && node.text === "children";
  const isReturned = (node: ts.Node): boolean =>
    (ts.isReturnStatement(node.parent) && node.parent.expression === node)
    || (ts.isArrowFunction(node.parent) && node.parent.body === node);
  // Rendered, not passed: an attribute value (`<Slot node={children} />`) is a
  // JsxExpression too, and wrapping it would mount nothing.
  const isRendered = (node: ts.JsxExpression): boolean =>
    ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent);
  let jsx: ts.Node | undefined;
  let returned: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (jsx !== undefined) return;
    if (router === "pages") {
      if (isPageComponentElement(ts, node)) jsx = node;
    } else if (ts.isJsxExpression(node) && isRendered(node) && isChildren(node.expression)) {
      jsx = node;
    } else if (returned === undefined && isChildren(node) && isReturned(node)) {
      returned = node;
    }
    ts.forEachChild(node, visit);
  };
  const root = defaultExportedComponent(sf);
  if (root === null) return null;
  visit(root);
  const target = jsx ?? returned;
  return target === undefined ? null : { start: target.getStart(sf), end: target.getEnd() };
}

/** One-splice paste: init dropped its layout codemod (see f2c23568) and only
 * prints a paste, so the corpus harness plays the human and pastes the
 * documented canonical mount — docs-site/quickstart.mdx, "The client mount".
 * It does NOT mirror init's printed block: init's copy is init's own contract
 * (packages/vendo/tests/cli/init.test.ts owns it), and wording changes there
 * must never fail the corpus. A green corpus run still means the app is wired
 * end to end, not just that init exited 0. The only thing it resolves besides
 * the client-root path (layers/structural.ts's findClientMount) is WHERE the
 * mounted child lives — a parse, because a text scan cannot tell a
 * rendered `{children}` from a destructured one. */
export async function applyVendoRootPaste(
  repoDir: string,
  framework: "next" | "express" | undefined,
): Promise<VendoRootPasteResult> {
  if ((framework ?? "next") === "express") {
    return {
      applied: false,
      file: null,
      reason: "express host — init prints server/client wiring lines, not a layout file to paste into",
    };
  }

  const mount = await findClientMount(repoDir);
  const filePath = path.join(repoDir, mount.mountRel);
  // clientRoot names the conventional app/layout.tsx as its last resort even
  // when no such file exists — init asks the host to create it. The corpus
  // plays the human who pastes, never the one who scaffolds a root layout.
  const original = await readOptional(filePath);
  if (original === undefined) {
    return { applied: false, file: mount.mountRel, reason: `client root ${mount.mountRel} does not exist — nothing to paste into` };
  }
  if (original.includes("<VendoProvider")) {
    return { applied: false, file: mount.mountRel, reason: "client root already wraps <VendoProvider> — left unchanged" };
  }

  const span = mountSpan(original, mount.mountRel, mount.router);
  if (span === null) {
    throw new Error(`${mount.mountRel} has no default-exported component rendering "${mountedChild(mount)}" for the mount to wrap`);
  }
  // The app-router paste is the canonical docs block verbatim; the pages paste
  // wraps in place instead, so the host's own props on <Component …> survive.
  const wrap = mount.router === "pages"
    ? PROVIDER_OPEN + original.slice(span.start, span.end) + PROVIDER_CLOSE
    : WRAP_EXPRESSION;
  const wrapped = original.slice(0, span.start) + wrap + original.slice(span.end);

  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = wrapped.split(/\r?\n/);
  const prologueEnd = directivePrologueEnd(lines);
  const pasted = [...lines.slice(0, prologueEnd), IMPORT_LINE, ...lines.slice(prologueEnd)].join(eol);
  await writeFile(filePath, pasted, "utf8");

  return { applied: true, file: mount.mountRel, reason: "pasted the VendoProvider import + wrap into the client root" };
}
