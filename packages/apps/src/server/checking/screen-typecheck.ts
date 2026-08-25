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

/**
 * An object literal that names a key its type has not got — a Kit item
 * description most often: a KeyValue item takes `key` + `cell`, and a screen
 * that wrote `{ label, field }` was told four times to "write the element
 * itself" when the element was already written and the KEY was wrong.
 *
 * The keys the item really accepts are the repair, in the same shape
 * {@link badPayloadMessage} gives a tool payload. The compiler prints the whole
 * item type inline, which is how these sentences come to mention {@link SLOT_TYPE}
 * at all.
 */
const badKeyMessage = (
  ts: typeof TS,
  file: TS.SourceFile,
  checker: TS.TypeChecker,
  node: TS.Node,
  sentence: string,
): string | undefined => {
  const property = node.parent;
  if (property === undefined || !ts.isPropertyAssignment(property) || property.name !== node) return undefined;
  if (!ts.isObjectLiteralExpression(property.parent)) return undefined;
  const contextual = checker.getContextualType(property.parent);
  // The OBJECT side of the contextual type, because a field description may be
  // written as a bare key (`kit/specs.ts` tableColumn) and its contextual type
  // is therefore a union — whose common properties are `toString` and `valueOf`.
  // A repair listing those names no key the item takes.
  const properties = (contextual === undefined ? [] : contextual.isUnion() ? contextual.types : [contextual])
    .filter((one) => (one.flags & ts.TypeFlags.Object) !== 0)
    .flatMap((one) => checker.getPropertiesOfType(one));
  if (properties.length === 0) return undefined;
  const required = properties
    .filter((symbol) => (symbol.flags & ts.SymbolFlags.Optional) === 0)
    .map((symbol) => symbol.getName());
  // The prop the object rides in, so the sentence names where the key was
  // written rather than leaving the author to find which literal it meant.
  let holder = "this object";
  for (let at: TS.Node | undefined = property.parent; at !== undefined; at = at.parent) {
    if (!ts.isJsxAttribute(at)) continue;
    holder = `${at.name.getText(file)} on <${at.parent.parent.tagName.getText(file)}>`;
    break;
  }
  return `writes the key "${node.getText(file)}", which ${holder} does not accept: ${sentence}`
    + ` Its keys are: ${list(properties.map((symbol) => symbol.getName()))}${required.length === 0 ? "" : ` (required: ${required.join(", ")})`}.`;
};

/** The one shape a slot-VALUE error takes: {@link SLOT_TYPE} as the type the
 *  compiler REFUSED a value against. A sentence that merely MENTIONS the alias is
 *  a different error about the object a slot sits in — a Kit item type prints
 *  inline (`{ key: string; …; cell?: VendoSlot }`, screen-typings.ts), so an
 *  unknown key in one names the alias while having nothing to do with a slot. Read
 *  as a slot error it produced a repair naming no key the item takes, which the
 *  auto-fixer could not act on either. */
const SLOT_REFUSED = new RegExp(`not assignable to type '${SLOT_TYPE}'`, "u");

/**
 * A CHANGE HANDLER handed the value's own setter — `onChange={setStatus}`, and
 * the arrow that only passes its parameter on.
 *
 * The React reflex, and the one shape that cannot work here: a Kit control calls
 * its change handler with the EVENT (`screen-typings.ts` HANDLER_TYPE, `ui`
 * kit/handler.ts `screenEvent`), so a setter handed it stores the whole
 * `{ target: … }` object and the control renders that instead of the choice. The
 * component cannot forgive it either — at runtime a one-argument setter and a
 * one-argument handler are the same value — so the repair is computed HERE, off
 * the AST, and only where it is fully determined.
 *
 * Only `onChange`: it is the one prop whose event CARRIES the value. `onClick`
 * has the same declared type and no value at all, so a line reading
 * `e.target.value` into it would be invented, not computed. And only where what
 * receives the value takes a string or a boolean — the two fields the event has
 * — which is what keeps a range picker's `{start, end}` out of this class.
 */
const CHANGE_PROP = "onChange";

/** Which field of the event holds the value, for whatever receives it: `checked`
 *  for a boolean, `value` for a string, and nothing at all for anything else —
 *  the event has no third field to read. */
const eventField = (ts: typeof TS, type: TS.Type): string | undefined => {
  const parts = type.isUnion() ? type.types : [type];
  if (parts.some((part) => (part.flags & ts.TypeFlags.BooleanLike) !== 0)) return "checked";
  return parts.some((part) => (part.flags & ts.TypeFlags.StringLike) !== 0) ? "value" : undefined;
};

/** The repaired handler, and the sentence around it. The identifier form prints
 *  the WHOLE attribute, which is what makes it the one class this gate's caller
 *  can apply itself (`packages/vendo` screen-agent.ts `CHANGE_HANDLER`); the
 *  arrow form prints the arrow, because only the screen knows what else its body
 *  was for. */
const changeHandlerMessage = (
  ts: typeof TS,
  file: TS.SourceFile,
  checker: TS.TypeChecker,
  node: TS.Node,
): string | undefined => {
  let attribute: TS.JsxAttribute | undefined;
  for (let at: TS.Node | undefined = node; at !== undefined && attribute === undefined; at = at.parent) {
    if (ts.isJsxAttribute(at)) attribute = at;
  }
  if (attribute === undefined || attribute.name.getText(file) !== CHANGE_PROP) return undefined;
  const initializer = attribute.initializer;
  if (initializer === undefined || !ts.isJsxExpression(initializer) || initializer.expression === undefined) return undefined;
  const written = initializer.expression;
  // The prop really takes an event, read off its declared type rather than off
  // the name: a host component free to declare its own `onChange` is not this.
  const takes = checker.getContextualType(written)?.getCallSignatures()[0]?.getParameters()[0];
  const event = takes === undefined ? undefined : checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(takes, written));
  if (event === undefined || checker.getPropertyOfType(event, "target") === undefined) return undefined;
  const tag = attribute.parent.parent.tagName.getText(file);
  const called = (field: string): string =>
    `"${CHANGE_PROP}" on <${tag}> is called with the change EVENT ({ target: { ${field} } }), not the value itself`;

  // The setter written bare. Its own first parameter says which field of the
  // event holds what it stores, so the whole attribute is determined.
  if (ts.isIdentifier(written)) {
    const parameter = checker.getTypeAtLocation(written).getCallSignatures()[0]?.getParameters()[0];
    const field = parameter === undefined ? undefined : eventField(ts, checker.getTypeOfSymbolAtLocation(parameter, written));
    if (field === undefined) return undefined;
    return `writes the state setter ${written.getText(file)} where a handler goes — ${called(field)},`
      + ` so what is stored is that object and the control renders it.`
      + ` Read the value off the event: ${CHANGE_PROP}={(e) => ${written.getText(file)}(e.target.${field})}.`;
  }

  // An arrow that passes its own parameter on as a value. Only where the
  // parameter is written ONCE: the line below is the whole handler, so a second
  // use of it would be a repair that drops what the screen wrote.
  if (!ts.isArrowFunction(written) || written.parameters.length !== 1 || !ts.isIdentifier(node)) return undefined;
  const parameter = written.parameters[0];
  if (parameter === undefined || !ts.isIdentifier(parameter.name)) return undefined;
  const name = parameter.name.getText(file);
  if (node.getText(file) !== name) return undefined;
  let uses = 0;
  const count = (at: TS.Node): void => {
    if (ts.isIdentifier(at) && at.getText(file) === name) uses += 1;
    ts.forEachChild(at, count);
  };
  count(written.body);
  const call = node.parent;
  if (uses !== 1 || call === undefined || !ts.isCallExpression(call)) return undefined;
  const index = call.arguments.findIndex((argument) => argument === node);
  const receives = index < 0 ? undefined : checker.getResolvedSignature(call)?.getParameters()[index];
  const field = receives === undefined ? undefined : eventField(ts, checker.getTypeOfSymbolAtLocation(receives, call));
  if (field === undefined) return undefined;
  const text = written.getText(file);
  const from = node.getStart(file) - written.getStart(file);
  const repair = `${text.slice(0, from)}${name}.target.${field}${text.slice(from + node.getWidth(file))}`;
  return `passes ${name} on as a value, but ${called(field)}.`
    + ` Read the value off the event: ${repair}.`;
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
    const key = badKeyMessage(ts, file, checker, node, sentence);
    if (key !== undefined) return at(key);
  }

  // A slot handed something that is neither an element nor a function returning
  // one, which in practice is a function of the ROW: this is the slot painted
  // ONCE, so the VM calls it with no arguments (`genui/component/vm-program.ts`
  // `emitSlot`) and the element it tries to build reads a field off `undefined`.
  //
  // A per-row slot is typed `VendoRowSlot` and takes the row's function, so it
  // never reaches here (screen-typings.ts).
  const slot = SLOT_REFUSED.test(sentence) ? slotLocus(ts, file, node) : undefined;
  if (slot !== undefined) {
    return at(`writes ${/^Type '([^']+)'/u.exec(sentence)?.[1] ?? "a value that is not an element"} in the "${slot.name}" slot`
      + `${slot.key === undefined ? "" : ` of ${slot.key}`}`
      + " — this slot is painted once, so it holds ELEMENTS, or a function of NO arguments that returns them."
      + " Write the element itself.");
  }

  if (MISSING_PROPERTY.has(diagnostic.code) || BAD_CALL.has(diagnostic.code) || diagnostic.code === 2322) {
    const handler = changeHandlerMessage(ts, file, checker, node);
    if (handler !== undefined) return at(handler);
    // A value refused INSIDE a tool payload arrives as 2322 — the assignment to
    // one nested field rather than the argument as a whole — and the locus a
    // sentence reads best from is the tool, not the control the call sits under:
    // an enum fed a widened value was stamped `<Button> prop "onClick"`, so the
    // repair looked like the handler and the payload was rewritten forever.
    const payload = badPayloadMessage(ts, file, checker, diagnostic, sentence);
    if (payload !== undefined) return at(payload);
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
