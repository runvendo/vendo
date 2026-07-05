/**
 * Baseline preparation (remix fast-edits follow-up): do the MECHANICAL part of
 * a first remix at sync time instead of paying a model round for it on every
 * user's first ask. Two surgical text edits, driven by AST positions so
 * everything else stays byte-identical (the model keeps seeing the dev's real
 * code, and no reformatting can perturb hunk targets):
 *
 *  1. remove the `@vendoai/shell` import statement;
 *  2. unwrap every `<VendoRemix ...>…</VendoRemix>` element, keeping its
 *     children (fragment-wrapped when there are several).
 *
 * Deterministic — no LLM, no network, same output every build. Fail-closed:
 * anything this can't handle mechanically (e.g. a non-JSX reference to
 * VendoRemix that would dangle) returns undefined and the anchor keeps the
 * verbatim source + the model-does-the-glue path.
 */
import ts from "typescript";

interface Splice {
  start: number;
  end: number;
  replacement: string;
}

export function prepareBaseline(source: string): string | undefined {
  const sourceFile = ts.createSourceFile("w.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const splices: Splice[] = [];
  let sawWrapper = false;
  let sawShellImport = false;
  let unmechanical = false;

  const visit = (node: ts.Node): void => {
    // 1. The @vendoai/shell import statement (whole line, incl. trailing newline).
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "@vendoai/shell"
    ) {
      sawShellImport = true;
      const start = node.getStart(sourceFile);
      let end = node.getEnd();
      if (source[end] === "\n") end += 1;
      splices.push({ start, end, replacement: "" });
      return;
    }
    // 2. VendoRemix JSX elements: drop the opening/closing tags, keep children.
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(sourceFile) === "VendoRemix"
    ) {
      sawWrapper = true;
      const elementChildren = node.children.filter(
        (c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces),
      );
      const fragment = elementChildren.length > 1;
      splices.push({
        start: node.openingElement.getStart(sourceFile),
        end: node.openingElement.getEnd(),
        replacement: fragment ? "<>" : "",
      });
      splices.push({
        start: node.closingElement.getStart(sourceFile),
        end: node.closingElement.getEnd(),
        replacement: fragment ? "</>" : "",
      });
      node.children.forEach(visit); // nested wrappers
      return;
    }
    // Any OTHER reference to VendoRemix (render props, aliasing, spread…)
    // would dangle once the import is gone — refuse, keep the verbatim path.
    if (ts.isIdentifier(node) && node.text === "VendoRemix") {
      const parent = node.parent;
      const inJsxTag =
        (ts.isJsxOpeningElement(parent) || ts.isJsxClosingElement(parent) || ts.isJsxSelfClosingElement(parent)) &&
        parent.tagName === node;
      const inImport = ts.isImportSpecifier(parent) || ts.isImportClause(parent);
      if (!inJsxTag && !inImport) unmechanical = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // Self-closing <VendoRemix /> (no children) can't be unwrapped into
  // anything — treat as unmechanical if present.
  const selfClosing = /<VendoRemix\b[^>]*\/>/.test(source);

  if (unmechanical || selfClosing) return undefined;
  if (!sawWrapper && !sawShellImport) return undefined;
  if (sawShellImport && !sawWrapper) return undefined; // import used some other way

  const out = [...splices]
    .sort((a, b) => b.start - a.start)
    .reduce((text, s) => text.slice(0, s.start) + s.replacement + text.slice(s.end), source);
  return out;
}
