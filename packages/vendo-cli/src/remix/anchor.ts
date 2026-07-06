/**
 * The remix anchor splice codemod — the edit half of the `vendo init` remix
 * picker (discovery is discover.ts, the picker wiring is Task 12).
 *
 * The LLM only SELECTS which file/component to make remixable (discover.ts);
 * the edit itself is a deterministic AST splice: wrap the named component's
 * single returned top-level JSX element in a `<VendoRemix id label>` anchor and
 * add the `@vendoai/shell` import. Same never-guess contract as the layout wrap
 * (see next-wiring.ts wrapLayoutChildren): SKIP with printed manual
 * instructions on ANY ambiguity, and NEVER emit code that fails a syntax
 * re-parse. No `context` prop is guessed — each successful anchor carries a TODO
 * pointing at the remix docs (anchors without context fall back to DOM-snapshot
 * baselines, which work).
 *
 * PURE string → result. No disk IO — the caller (Task 12) writes the file and
 * prints the TODO. Deterministic AST work only (TypeScript compiler API).
 */
import ts from "typescript";
import { insertImportAfterDirectives, maskLiterals } from "../next-wiring.js";
import { findImport } from "../sync/capture.js";

const SHELL_IMPORT = `import { VendoRemix } from "@vendoai/shell";\n`;

export interface SpliceRequest {
  /** The component to wrap. Chosen by the LLM in discovery (RemixCandidate). */
  componentName: string;
  /** kebab-case anchor id — already sanitized by Task 10 to [a-z0-9-]. */
  id: string;
  /** Human label — already sanitized by Task 10. */
  label: string;
  /** Source file name, used to pick the parse ScriptKind. Optional; when both
   *  this and {@link scriptKind} are absent the parser defaults to TSX. */
  fileName?: string;
  /** Explicit parse mode; overrides {@link fileName} when given. */
  scriptKind?: ts.ScriptKind;
}

export type SpliceResult =
  | { ok: true; code: string }
  | { ok: false; reason: string; manual: string };

/** ScriptKind for a source path: .tsx→TSX, .jsx→JSX, .ts→TS, .js→JS, else TSX. */
export function scriptKindForFile(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (fileName.endsWith(".ts")) return ts.ScriptKind.TS;
  if (fileName.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TSX;
}

/** Does re-parsing `code` at `scriptKind` produce any parse diagnostics? The
 *  hard gate: a splice that fails this is dropped, never written. */
export function hasSyntaxErrors(code: string, scriptKind: ts.ScriptKind): boolean {
  const sf = ts.createSourceFile("__check__.tsx", code, ts.ScriptTarget.Latest, false, scriptKind);
  const diags = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  return (diags?.length ?? 0) > 0;
}

/** The per-anchor context TODO printed by the caller on a successful splice.
 *  We never guess a `context` prop — this points the developer at the docs. */
export function remixContextTodo(id: string): string {
  return (
    `<VendoRemix id="${id}"> is live — optionally add a \`context\` prop to feed it ` +
    `the widget's live data (see the remix docs). Without one it falls back to a ` +
    `DOM-snapshot baseline, which works.`
  );
}

function manualInstructions(componentName: string, id: string, label: string): string {
  return (
    `wrap ${componentName}'s returned element by hand:\n` +
    `    import { VendoRemix } from "@vendoai/shell";\n` +
    `    <VendoRemix id="${id}" label="${label}">…your element…</VendoRemix>`
  );
}

function skip(componentName: string, id: string, label: string, reason: string): SpliceResult {
  return { ok: false, reason, manual: manualInstructions(componentName, id, label) };
}

/** Leading whitespace of the line `pos` sits on (mirrors next-wiring's helper). */
function leadingIndent(source: string, pos: number): string {
  const lineStart = source.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  return source.slice(lineStart, pos).match(/^[ \t]*/)?.[0] ?? "";
}

/** Locate the top-level component named `name` as a function/arrow node. */
function findComponent(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | undefined {
  for (const stmt of sf.statements) {
    // `function Name`, `export function Name`, `export default function Name`.
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt;
    // `const Name = (...) => ...` / `const Name = function (...) {...}` (+ export).
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== name || !decl.initializer) continue;
        const init = decl.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
      }
    }
  }
  return undefined;
}

function unwrapParens(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

/** Does the subtree contain any JSX (descending into nested callbacks — a
 *  `.map(x => <li/>)` still "renders JSX", so it's flagged as a list root, not
 *  mistaken for a non-JSX return)? */
function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Return statements OWNED by this function body — nested functions/arrows/
 *  callbacks are NOT descended into, so their returns don't count. */
function ownReturns(body: ts.Block): ts.ReturnStatement[] {
  const returns: ts.ReturnStatement[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
    if (ts.isReturnStatement(n)) returns.push(n);
    ts.forEachChild(n, visit);
  };
  body.statements.forEach(visit);
  return returns;
}

type TargetResult =
  | { ok: true; node: ts.JsxElement | ts.JsxSelfClosingElement }
  | { ok: false; reason: string };

/**
 * The single top-level JSX element this component returns. Ambiguity → skip:
 *   - 0 JSX-rendering returns → "no JSX return"
 *   - >1 JSX-rendering returns → "multiple returns"
 *   - the rendered expression is a fragment / conditional / list / other → not
 *     a single element.
 */
function findReturnTarget(fn: ts.FunctionLikeDeclaration, name: string): TargetResult {
  const body = fn.body;
  if (!body) return { ok: false, reason: `${name} has no body` };

  // Every expression this component might render as its root.
  let candidates: ts.Expression[];
  if (ts.isBlock(body)) {
    candidates = ownReturns(body)
      .map((r) => r.expression)
      .filter((e): e is ts.Expression => !!e && containsJsx(e));
  } else {
    // Arrow concise body (`() => <X/>`): the body IS the returned expression.
    candidates = containsJsx(body) ? [body] : [];
  }

  if (candidates.length === 0) return { ok: false, reason: `no JSX return found in ${name}` };
  if (candidates.length > 1) return { ok: false, reason: `${name} has multiple returns with JSX` };

  const expr = unwrapParens(candidates[0]!);
  if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr)) return { ok: true, node: expr };
  if (ts.isJsxFragment(expr)) {
    return { ok: false, reason: `${name} returns a JSX fragment (<>…</>), not a single element` };
  }
  return { ok: false, reason: `${name}'s return is not a single JSX element (e.g. a conditional or list)` };
}

/**
 * Wrap the named component's single returned top-level JSX element in a
 * `<VendoRemix id label>` anchor and add the `@vendoai/shell` import. Returns
 * the edited code, or an ok:false skip with manual instructions.
 */
export function spliceRemixAnchor(source: string, req: SpliceRequest): SpliceResult {
  const { componentName, id, label } = req;
  const scriptKind = req.scriptKind ?? (req.fileName ? scriptKindForFile(req.fileName) : ts.ScriptKind.TSX);

  // Emit-safety on the attribute values. ids are [a-z0-9-] from Task 10; guard
  // anyway. Labels are human text destined for a JSX string attribute — a `"`
  // or newline would break out of it, so reject rather than mangle.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return skip(componentName, id, label, `anchor id "${id}" is not a safe kebab-case identifier`);
  }
  if (/["\r\n]/.test(label)) {
    return skip(componentName, id, label, `anchor label contains a quote or newline — cannot emit safely`);
  }

  // Idempotence: already anchored (by us or by hand). Checked on the masked view
  // so a VendoRemix mention in a comment/string can't false-positive.
  if (maskLiterals(source).includes("<VendoRemix")) {
    return skip(componentName, id, label, `${componentName}'s file already contains a VendoRemix anchor`);
  }

  const sf = ts.createSourceFile("__source__.tsx", source, ts.ScriptTarget.Latest, true, scriptKind);

  const fn = findComponent(sf, componentName);
  if (!fn) {
    return skip(componentName, id, label, `component ${componentName} not found (or not a function/arrow component)`);
  }

  const target = findReturnTarget(fn, componentName);
  if (!target.ok) return skip(componentName, id, label, target.reason);

  // Splice: replace the exact original element text with the anchor wrapper.
  const start = target.node.getStart(sf);
  const end = target.node.getEnd();
  const original = source.slice(start, end);
  const indent = leadingIndent(source, start);
  const wrapper =
    `<VendoRemix id="${id}" label="${label}">\n` +
    `${indent}  ${original}\n` +
    `${indent}</VendoRemix>`;
  let code = source.slice(0, start) + wrapper + source.slice(end);

  // Add the shell import unless one already brings VendoRemix in.
  if (!findImport(sf, "VendoRemix")) {
    code = insertImportAfterDirectives(code, SHELL_IMPORT);
  }

  // Hard gate: never write something that doesn't parse.
  if (hasSyntaxErrors(code, scriptKind)) {
    return skip(componentName, id, label, `the anchor splice would not parse — left ${componentName} untouched`);
  }

  return { ok: true, code };
}
