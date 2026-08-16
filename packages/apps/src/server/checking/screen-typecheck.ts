/**
 * Stage 3's translation: one compiled screen's diagnostics as repair
 * instructions.
 *
 * Split out of the gauntlet because it travels with the COMPILER, not with the
 * gate. Every sentence here is written off the AST — the node under a
 * diagnostic, the resolved signature of the call around it, the tag of the
 * element it sits in — and an AST walk cannot cross a service binding. So a
 * toolchain that type-checks somewhere else translates there too, and both run
 * THIS translation: a screen author reads the same sentence whatever compiled
 * the screen.
 *
 * Only the classes whose prose is specific to this dialect are written here —
 * the surface is two modules, there is no DOM, and a tool payload is a schema.
 * Everything else is handed to the wire screen's own translator (screen-tsc.ts),
 * which already says the right thing about props, arguments and missing fields.
 */
import { DISPLAY_TAG_NAMES } from "../../contract/index.js";
import { diagnosticLine, translateDiagnostic, type ScreenProgram } from "./screen-program.js";
import { SCREEN_MODULE, SLOT_TYPE } from "./screen-typings.js";
import type { ComponentScreenIssue } from "./component-screen.js";
import type TS from "typescript";

/** The gauntlet's shared sentence vocabulary. It lives with the translation
 *  below because that is the leaf of the checking graph — the scan imports from
 *  here, and a second spelling of either would be two sentences for one rule. */
export const QUERY_HOOK = "useQuery";

export const list = (names: readonly string[]): string => (names.length === 0 ? "(none)" : names.join(", "));

const issue = (code: string, message: string): ComponentScreenIssue => ({ code, message });

/** "Cannot find name X", in all its forms. 2304 is the plain one and 2552 the
 *  one with a spelling suggestion; the 258x family is the SAME error with a
 *  "change your target library" or "install @types/…" hint attached — advice a
 *  screen author cannot act on, since there is no tsconfig here and the missing
 *  lib (`dom`) is missing on purpose. */
const UNKNOWN_NAME = new Set([2304, 2552, 2580, 2581, 2582, 2583, 2584, 2591, 2592, 2593]);
const MISSING_PROPERTY = new Set([2339, 2551]);
const NO_SUCH_EXPORT = new Set([2305, 2724]);
const MISSING_MODULE = new Set([2307, 2792]);
// 2353 is the excess-property error on its own, which is how a misspelled tool
// payload key arrives.
const BAD_CALL = new Set([2345, 2769, 2353]);

const INTRINSIC_ELEMENT = /Property '([^']+)' does not exist on type 'JSX\.IntrinsicElements'/u;

/** Where a value written into a SLOT sits, as the screen wrote it: the property holding it
 *  (`cell`, `rowActions`) and, when it rides in a column or field description,
 *  that description's own `key`. The compiler's sentence names the type it
 *  refused and nothing at all about where it stands. */
const slotLocus = (
  ts: typeof TS,
  file: TS.SourceFile,
  node: TS.Node,
): { name: string; key?: string } | undefined => {
  for (let at: TS.Node | undefined = node; at !== undefined; at = at.parent) {
    if (ts.isJsxAttribute(at)) return { name: at.name.getText(file) };
    if (!ts.isPropertyAssignment(at)) continue;
    const key = ts.isObjectLiteralExpression(at.parent)
      ? at.parent.properties.find((property) => property.name?.getText(file) === "key")
      : undefined;
    return {
      name: at.name.getText(file),
      ...(key !== undefined && ts.isPropertyAssignment(key) ? { key: key.initializer.getText(file) } : {}),
    };
  }
  return undefined;
};

/** The deepest node covering a diagnostic — the same descent screen-tsc.ts uses
 *  to anchor its own findings. */
const nodeAt = (ts: typeof TS, file: TS.SourceFile, diagnostic: TS.Diagnostic): TS.Node => {
  const start = diagnostic.start ?? 0;
  const end = start + (diagnostic.length ?? 0);
  let best: TS.Node = file;
  const descend = (node: TS.Node): void => {
    if (node.getStart(file) > start || end > node.getEnd()) return;
    best = node;
    ts.forEachChild(node, descend);
  };
  ts.forEachChild(file, descend);
  return best;
};

/** The nearest enclosing call whose ARGUMENT holds the diagnostic, with the
 *  keys that argument's type really accepts. */
const badPayloadMessage = (
  ts: typeof TS,
  file: TS.SourceFile,
  checker: TS.TypeChecker,
  diagnostic: TS.Diagnostic,
  sentence: string,
): string | undefined => {
  const start = diagnostic.start ?? 0;
  const end = start + (diagnostic.length ?? 0);
  const covers = (node: TS.Node): boolean => node.getStart(file) <= start && end <= node.getEnd();
  for (let current: TS.Node | undefined = nodeAt(ts, file, diagnostic); current !== undefined; current = current.parent) {
    if (!ts.isCallExpression(current)) continue;
    const index = current.arguments.findIndex(covers);
    if (index < 0) continue;
    const callee = current.expression.getText(file);
    if (!callee.startsWith("tools.") && callee !== QUERY_HOOK) return undefined;
    const parameter = checker.getResolvedSignature(current)?.getParameters()[index];
    const type = parameter === undefined ? undefined : checker.getTypeOfSymbolAtLocation(parameter, current);
    const properties = type === undefined ? [] : checker.getPropertiesOfType(type);
    const required = properties
      .filter((symbol) => (symbol.flags & ts.SymbolFlags.Optional) === 0)
      .map((symbol) => symbol.getName());
    return `calls ${callee}(…) with an input its schema does not accept: ${sentence}`
      + (properties.length === 0
        ? ""
        : ` Its input keys are: ${list(properties.map((symbol) => symbol.getName()))}${required.length === 0 ? "" : ` (required: ${required.join(", ")})`}.`);
  }
  return undefined;
};

/** One diagnostic as a repair instruction. */
const typeIssue = (
  ts: typeof TS,
  file: TS.SourceFile,
  checker: TS.TypeChecker,
  diagnostic: TS.Diagnostic,
  surface: { components: readonly string[] },
): ComponentScreenIssue | undefined => {
  const line = diagnosticLine(file, diagnostic);
  const sentence = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  const at = (message: string): ComponentScreenIssue => issue("types", `line ${line}: ${message}`);
  const node = nodeAt(ts, file, diagnostic);
  // A bad tag is reported twice, on `<div>` and again on `</div>`. The closing
  // one is the same break, and a repair list that says everything twice reads
  // as two problems.
  if (ts.isJsxClosingElement(node) || (node.parent !== undefined && ts.isJsxClosingElement(node.parent))) {
    return undefined;
  }

  const intrinsic = INTRINSIC_ELEMENT.exec(sentence);
  if (intrinsic !== null) {
    return at(`writes the HTML element <${intrinsic[1]}>, which a screen does not have. The HTML a screen has is display-only: ${list(DISPLAY_TAG_NAMES)} — each taking children and an inline style and nothing else. Anything with behavior comes from ${JSON.stringify(SCREEN_MODULE)}: ${list(surface.components)}.`);
  }

  if (UNKNOWN_NAME.has(diagnostic.code)) {
    // The compiler anchors a tag error on the whole tag as often as on the name
    // inside it, so the element is read from either.
    const element = ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)
      ? node
      : (node.parent !== undefined && (ts.isJsxOpeningElement(node.parent) || ts.isJsxSelfClosingElement(node.parent))
        ? node.parent
        : undefined);
    return at(element === undefined
      ? `reads the name "${node.getText(file)}", which does not exist inside a screen — there is no DOM, no window/document, no fetch, no timers and no process here. Read data with ${QUERY_HOOK}("tool_name"), act with tools.tool_name(args), and import anything else from "react" or ${JSON.stringify(SCREEN_MODULE)}.`
      : `renders <${element.tagName.getText(file)}>, which this screen never imported — import the component from ${JSON.stringify(SCREEN_MODULE)}. The components available are: ${list(surface.components)}.`);
  }

  if (NO_SUCH_EXPORT.has(diagnostic.code)) {
    return at(`${sentence} The screen surface is ${QUERY_HOOK}, tools, and these components: ${list(surface.components)}.`);
  }

  if (MISSING_MODULE.has(diagnostic.code)) {
    return at(`${sentence} A screen may import only "react" and ${JSON.stringify(SCREEN_MODULE)}.`);
  }

  if (BAD_CALL.has(diagnostic.code)) {
    const payload = badPayloadMessage(ts, file, checker, diagnostic, sentence);
    if (payload !== undefined) return at(payload);
  }

  // A slot handed something that is not an element, which in practice is a
  // FUNCTION: the VM serializes a function prop as a `$handler` door
  // (`genui/component/vm-program.ts` `emitValue`), so the slot receives a
  // callback the renderer cannot paint and the cell renders BLANK with every
  // gate green — how a generated screen shipped a column of empty cells.
  const slot = sentence.includes(SLOT_TYPE) ? slotLocus(ts, file, node) : undefined;
  if (slot !== undefined) {
    return at(`writes ${/^Type '([^']+)'/u.exec(sentence)?.[1] ?? "a value that is not an element"} in the "${slot.name}" slot`
      + `${slot.key === undefined ? "" : ` of ${slot.key}`}`
      + " — a slot holds ELEMENTS, and a function prop serializes as a callback the renderer cannot paint, so the slot renders blank."
      + (slot.key === undefined
        ? " Write the element itself."
        // `Text` reads any field, so the example is right whatever the column
        // holds; a value component (Money, EnumBadge) is the better answer where
        // the field's type is one it formats.
        : ` Write the element itself; the components inside a slot name their own row's field: ${slot.name}={<Text field=${slot.key}/>}.`));
  }

  if (MISSING_PROPERTY.has(diagnostic.code) || BAD_CALL.has(diagnostic.code) || diagnostic.code === 2322) {
    const [reused] = translateDiagnostic(ts, file, checker, diagnostic);
    // The wire translator's `where` is a locus its sentence sometimes states
    // itself, and prefixing it anyway said `prop "variant" prop "variant" on
    // <Text> takes …`. A sentence that names its own locus stands alone; the
    // line number is already the prefix here either way.
    if (reused !== undefined) {
      return at(reused.message.startsWith("prop \"") ? reused.message : `${reused.where} ${reused.message}`);
    }
  }

  return at(sentence);
};

/**
 * Every issue one type-checked screen carries.
 *
 * Syntax errors alone when there are any: semantic diagnostics over a file that
 * does not parse are a cascade of consequences of the same break, which
 * {@link ScreenProgram} already encodes by leaving `semantic` empty.
 *
 * `components` are the names the refusal sentences list — the declared surface,
 * deduplicated here so a catalog that names one component twice does not offer
 * it twice.
 */
export function screenTypecheckIssues(
  program: Extract<ScreenProgram, { ok: true }>,
  components: readonly string[],
): ComponentScreenIssue[] {
  const surface = { components: [...new Set(components)] };
  return [
    ...program.syntactic.map((diagnostic) => issue("types", `line ${diagnosticLine(program.file, diagnostic)}: does not parse as a screen: ${program.ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`)),
    ...program.semantic.flatMap((diagnostic) => {
      const found = typeIssue(program.ts, program.file, program.checker, diagnostic, surface);
      return found === undefined ? [] : [found];
    }),
  ];
}
