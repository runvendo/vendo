import path from "node:path";
import { DISPLAY_TAG_NAMES, SAFE_STYLE_PROPERTIES } from "@vendoai/apps/contract";
import type TS from "typescript";
import { parseModuleSource } from "../common.js";

/**
 * THE CARVER. Inline unportable subtrees become HOLES; a plain `<button>`
 * becomes the Kit Button.
 *
 * A real host component is rarely portable whole: its chart is hand-rolled SVG,
 * its count-up hook reads `requestAnimationFrame`, its icons are inlined
 * `<path>` data. None of that may enter the dialect — and none of it needs to:
 * a hole is host code rendered natively by the host, so the cut keeps every
 * unportable part at home, in the host's own React, referenced by name from the
 * port. The SVG vocabulary never widens; the code that needs a browser keeps
 * one.
 *
 * What is cut, and the judge for each:
 *
 *  - a TOP-LEVEL declaration (a same-module component or hook) whose body
 *    writes a tag outside the display allowlist or reads a name only the DOM
 *    lib declares — the same two facts the gauntlet refuses on, asked of the
 *    host's own compiler (`lib.dom` is where a name that "does not exist inside
 *    a screen" lives; the check's own lib is ES-only);
 *  - an INLINE subtree of the component whose tag is outside the allowlist —
 *    cut at the outermost such element into a generated home component, the
 *    names it reads from the component's own scope becoming its props;
 *  - a HOOK the component calls whose declaration was cut: the hook cannot
 *    leave the component body — React pins it there — so the cut carries the
 *    hook and the ONE element its value paints together, under a provable
 *    guard. Any guard miss refuses loudly; a hole that guesses ships a
 *    component that silently paints the wrong thing, which is worse.
 *
 * Nothing here is a second opinion about portability: the gauntlet still
 * grades every emitted port, and a carve this file gets wrong is a refusal
 * with the gauntlet's own reasons, never a silent pass.
 */

export interface CarveResult {
  /** The module with unportable declarations cut, subtrees replaced, buttons
   *  rewritten — or the input untouched when there was nothing to carve. */
  source: string;
  /** Hole components the cut produced, exported by {@link CarveResult.home}. */
  holes: string[];
  /** The generated home module: the cut declarations, their module-level
   *  closure, the generated wrappers, and exactly the imports those need. */
  home?: string;
  /** A `<button>` was rewritten, so the port imports the Kit Button. */
  button: boolean;
  /** Guard refusals — loud, named, and terminal for this slot's port. */
  issues: string[];
}

const untouched = (source: string): CarveResult =>
  ({ source, holes: [], button: false, issues: [] });

/** The tags a port may keep: the display allowlist, plus `button`, which is
 *  not kept but REWRITTEN — it must not force a cut around itself. */
const PORTABLE_TAGS: ReadonlySet<string> = new Set([...DISPLAY_TAG_NAMES, "button"]);

const pascal = (name: string): string =>
  name.replace(/(?:^|[^A-Za-z0-9]+)([a-z0-9])/gu, (_, first: string) => first.toUpperCase())
    .replace(/[^A-Za-z0-9]+/gu, "");

interface Edit { start: number; end: number; text: string }

/** Prop-shaped type facts threaded from the checker to a generated wrapper's
 *  signature (or a hook's own carried arguments). */
type PropFact = { name: string; type: string; optional: boolean };

/** A cut top-level declaration the kept region still reads only from JSX tag
 *  position: it stays home, and the port references it as a hole. */
interface HoleDeclaration { statement: TS.Statement; name: string }

/** A cut hook whose value was proven to flow into exactly one JSX element:
 *  the wrapper that carries the hook and that one element home together. */
interface HookCarve {
  statement: TS.Statement;
  hookName: string;
  binding: TS.VariableStatement;
  bindingName: string;
  element: TS.JsxElement | TS.JsxSelfClosingElement;
  parameters: PropFact[];
  argumentTexts: string[];
  wrapper: string;
}

interface ElementScan {
  props: PropFact[];
  closureSeeds: TS.Node[];
}

/** Shared read state threaded through every extraction phase once the slot's
 *  component declaration is known — the compiler API, the checked source
 *  file, its checker, the original text, and the running refusal list. */
interface CarveContext {
  ts: typeof TS;
  sf: TS.SourceFile;
  checker: TS.TypeChecker;
  source: string;
  slot: string;
  componentStatement: TS.Statement;
  issues: string[];
}

/** The host's own compiler over the host's own file: symbol resolution is what
 *  separates "reads a browser API" from "reads its own helper", and the local
 *  types are what let a free variable become a typed prop. Imports that do not
 *  resolve cost nothing — every question asked here is about THIS module.
 *  Refuses when the program cannot be built, or when the checked file has
 *  drifted from the text on disk. */
function resolveCheckedSourceFile(
  ts: typeof TS,
  file: string,
  source: string,
): { sf: TS.SourceFile; checker: TS.TypeChecker } | undefined {
  let program: TS.Program;
  try {
    program = ts.createProgram({
      rootNames: [file],
      options: {
        jsx: ts.JsxEmit.Preserve,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowJs: true,
      },
    });
  } catch {
    return undefined;
  }
  const sf = program.getSourceFile(file);
  // A capture that drifted from the file on disk is not this module: carve
  // nothing, and let the gauntlet say why the naive port refuses.
  if (sf === undefined || sf.text !== source) return undefined;
  return { sf, checker: program.getTypeChecker() };
}

/** The top-level statement `node` lives under, by climbing parents to the
 *  source file. */
function topLevelStatementOf(ts: typeof TS, node: TS.Node): TS.Statement | undefined {
  let at: TS.Node = node;
  while (at.parent !== undefined && !ts.isSourceFile(at.parent)) at = at.parent;
  return at.parent !== undefined && ts.isSourceFile(at.parent) ? at as TS.Statement : undefined;
}

/** Named top-level statements, by name: the cut candidates and the closure —
 *  and the slot's own component among them. `undefined` when the slot names
 *  nothing the module declares at the top level. */
function findComponentDeclaration(
  ts: typeof TS,
  sf: TS.SourceFile,
  slot: string,
): { topLevel: Map<string, TS.Statement>; componentStatement: TS.Statement } | undefined {
  const topLevel = new Map<string, TS.Statement>();
  for (const statement of sf.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)) && statement.name !== undefined) {
      topLevel.set(statement.name.text, statement);
    }
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
      const [declaration] = statement.declarationList.declarations;
      if (declaration !== undefined && ts.isIdentifier(declaration.name)) topLevel.set(declaration.name.text, statement);
    }
  }
  const componentStatement = topLevel.get(slot);
  return componentStatement === undefined ? undefined : { topLevel, componentStatement };
}

/** Depth-first visit of `root` and its descendants; `visit` returning `false`
 *  prunes that node's children. */
function walk(ts: typeof TS, root: TS.Node, visit: (node: TS.Node) => boolean | void): void {
  const step = (node: TS.Node): void => {
    if (visit(node) === false) return;
    ts.forEachChild(node, step);
  };
  step(root);
}

/** The tag name of a JSX opening/self-closing element, or `undefined` for
 *  anything else (including a computed or member-expression tag). */
function tagOf(ts: typeof TS, node: TS.Node): string | undefined {
  return (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)
    ? node.tagName.text
    : undefined;
}

/** A DOM tag outside the display allowlist — `button` excluded, since it is
 *  rewritten rather than cut. */
function unportableTag(tag: string | undefined): boolean {
  return tag !== undefined && /^[a-z]/u.test(tag) && !PORTABLE_TAGS.has(tag);
}

/** A name in reading position — never a property's own name, an attribute's,
 *  or a declaration's. Those belong to their object or their declaration; a
 *  READ is what makes a scope demand the name exist. */
function isRead(ts: typeof TS, id: TS.Identifier): boolean {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  if (ts.isJsxAttribute(parent)) return false;
  if (ts.isPropertySignature(parent) && parent.name === id) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isParameter(parent) || ts.isVariableDeclaration(parent)
    || ts.isBindingElement(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent))
    && (parent as { name?: TS.Node }).name === id) return false;
  return true;
}

/** A name the gauntlet's ES-only lib refuses with "does not exist inside a
 *  screen": every declaration is the ENVIRONMENT's (a default lib, or an
 *  ambient @types package like node's — `performance` is declared by both),
 *  and none is the ES lib's own. The host's module scope and its imports are
 *  never environment, so a host helper shadowing a global stays portable. */
function domOnly(ts: typeof TS, checker: TS.TypeChecker, id: TS.Identifier): boolean {
  if (!isRead(ts, id)) return false;
  const declarations = checker.getSymbolAtLocation(id)?.declarations ?? [];
  if (declarations.length === 0) return false;
  const libNames = declarations.map((declaration) => path.basename(declaration.getSourceFile().fileName));
  const ambient = declarations.every((declaration, index) =>
    libNames[index]!.startsWith("lib.") || declaration.getSourceFile().fileName.includes("/node_modules/"));
  return ambient && !libNames.some((name) => name.startsWith("lib.es"));
}

/** A top-level declaration whose body writes a tag outside the display
 *  allowlist or reads a name only the DOM lib declares — the same two facts
 *  the gauntlet refuses on, asked of the host's own compiler. */
function statementIsUnportable(ts: typeof TS, checker: TS.TypeChecker, statement: TS.Statement): boolean {
  let hit = false;
  walk(ts, statement, (node) => {
    if (unportableTag(tagOf(ts, node))) hit = true;
    if (ts.isIdentifier(node) && domOnly(ts, checker, node)) hit = true;
  });
  return hit;
}

/** Whether `node`'s span falls entirely inside one of `ranges`. */
function insideAny(sf: TS.SourceFile, node: TS.Node, ranges: ReadonlyArray<TS.Node>): boolean {
  return ranges.some((range) => node.getStart(sf) >= range.getStart(sf) && node.end <= range.end);
}

/** Cut candidates: unportable top-level declarations, the component's own
 *  outermost unportable JSX subtrees (cut whole, so everything under them
 *  goes home together), and the buttons OUTSIDE those subtrees (a button
 *  inside a cut renders at home as the host's own element). `undefined` when
 *  there is nothing to carve. */
function computeCutSet(ctx: CarveContext, topLevel: Map<string, TS.Statement>): {
  cutStatements: Set<TS.Statement>;
  subtreeRoots: Array<TS.JsxElement | TS.JsxSelfClosingElement>;
  buttons: Array<TS.JsxElement | TS.JsxSelfClosingElement>;
} | undefined {
  const { ts, checker, componentStatement, slot } = ctx;
  const cutStatements = new Set<TS.Statement>();
  for (const [name, statement] of topLevel) {
    if (statement === componentStatement || name === slot) continue;
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
    if (statementIsUnportable(ts, checker, statement)) cutStatements.add(statement);
  }

  const subtreeRoots: Array<TS.JsxElement | TS.JsxSelfClosingElement> = [];
  const buttons: Array<TS.JsxElement | TS.JsxSelfClosingElement> = [];
  walk(ts, componentStatement, (node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = tagOf(ts, opening);
      if (unportableTag(tag)) {
        subtreeRoots.push(node);
        return false;
      }
      if (tag === "button") buttons.push(node);
    }
    return undefined;
  });

  return cutStatements.size === 0 && subtreeRoots.length === 0 && buttons.length === 0
    ? undefined
    : { cutStatements, subtreeRoots, buttons };
}

/** Kept-region references to `name`, by symbol identity with its declaration. */
function keptReferences(
  ctx: CarveContext,
  cutRanges: ReadonlyArray<TS.Node>,
  name: string,
  statement: TS.Statement,
): TS.Identifier[] {
  const { ts, sf, checker } = ctx;
  const references: TS.Identifier[] = [];
  walk(ts, sf, (node) => {
    if (!ts.isIdentifier(node) || node.text !== name || !isRead(ts, node)) return;
    if (insideAny(sf, node, cutRanges)) return;
    const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
    if (declaration !== undefined && topLevelStatementOf(ts, declaration) === statement) references.push(node);
  });
  return references;
}

/** True when `node`'s span falls inside the slot's own component statement —
 *  the region a hook's binding and JSX must stay in to be provably carryable. */
function withinComponent(ctx: CarveContext, node: TS.Node): boolean {
  const { sf, componentStatement } = ctx;
  return node.getStart(sf) >= componentStatement.getStart(sf) && node.end <= componentStatement.end;
}

/** A checked type reduced to the JSON shapes a hole's props may carry; `null`
 *  when the type escapes what a tree node can serialize. */
function jsonTypeText(ts: typeof TS, checker: TS.TypeChecker, type: TS.Type, depth = 0): string | null {
  const base = checker.getBaseTypeOfLiteralType(type);
  const flags = base.getFlags();
  if (flags & ts.TypeFlags.String) return "string";
  if (flags & ts.TypeFlags.Number) return "number";
  if (flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) return "boolean";
  if (flags & ts.TypeFlags.Null) return "null";
  if (flags & ts.TypeFlags.Undefined) return "undefined";
  if (base.isUnion()) {
    const parts = base.types.map((member) => jsonTypeText(ts, checker, member, depth));
    if (parts.some((part) => part === null)) return null;
    return [...new Set(parts as string[])].join(" | ");
  }
  if (checker.isArrayType(base)) {
    const [element] = checker.getTypeArguments(base as TS.TypeReference);
    const inner = element === undefined ? null : jsonTypeText(ts, checker, element, depth + 1);
    return inner === null ? null : (inner.includes(" ") ? `Array<${inner}>` : `${inner}[]`);
  }
  if (flags & ts.TypeFlags.Object && depth < 3) {
    const properties = base.getProperties();
    if (properties.length === 0) return null;
    const fields = properties.map((property) => {
      const declaration = property.declarations?.[0];
      if (declaration === undefined) return null;
      const inner = jsonTypeText(ts, checker, checker.getTypeOfSymbolAtLocation(property, declaration), depth + 1);
      return inner === null ? null : `${property.name}: ${inner}`;
    });
    if (fields.some((field) => field === null)) return null;
    return `{ ${fields.join("; ")} }`;
  }
  return null;
}

/** A prop off a checked type: `T | undefined` prints as an optional `T`. */
function propOf(ts: typeof TS, checker: TS.TypeChecker, name: string, type: TS.Type): PropFact | null {
  const text = jsonTypeText(ts, checker, type);
  if (text === null) return null;
  const parts = text.split(" | ").filter((part) => part !== "undefined");
  return parts.length === 0 ? null : { name, type: parts.join(" | "), optional: parts.length !== text.split(" | ").length };
}

/** Free variables of a cut element: names read from the component's own
 *  scope become props (when they carry a serializable type) or refusals, and
 *  names whose home lies elsewhere become closure seeds for the home module. */
function scanElement(
  ctx: CarveContext,
  element: TS.Node,
  what: string,
  exclude: ReadonlySet<string>,
): ElementScan | null {
  const { ts, sf, checker, componentStatement, slot, issues } = ctx;
  const props: PropFact[] = [];
  const closureSeeds: TS.Node[] = [];
  let refused = false;
  walk(ts, element, (node) => {
    if (!ts.isIdentifier(node) || !isRead(ts, node) || exclude.has(node.text)) return;
    const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
    if (declaration === undefined) return; // a global — it resolves at home
    if (declaration.getStart(sf) >= element.getStart(sf) && declaration.end <= element.end
      && declaration.getSourceFile() === sf) return; // bound inside the cut
    const home = topLevelStatementOf(ts, declaration);
    if (declaration.getSourceFile() !== sf || home === undefined) return;
    if (ts.isImportDeclaration(home) || home !== componentStatement) {
      closureSeeds.push(node);
      return;
    }
    // Declared in the component, read by the cut: it crosses as a PROP, so it
    // must be a value a tree node can carry.
    if (tagOf(ts, node.parent) !== undefined) {
      issues.push(`its ${what} renders <${node.text}>, a component declared inside ${slot} itself — a hole cannot carry one`);
      refused = true;
      return;
    }
    if (props.some((prop) => prop.name === node.text)) return;
    const prop = propOf(ts, checker, node.text, checker.getTypeAtLocation(node));
    if (prop === null) {
      issues.push(`its ${what} reads ${node.text} from ${slot}'s own scope, and ${node.text}'s type cannot ride a tree node as a prop — a hole may only be handed serializable values`);
      refused = true;
      return;
    }
    props.push(prop);
  });
  return refused ? null : { props, closureSeeds };
}

/** THE HOOK-CARRYING GUARD. Provable, never heuristic; any miss refuses. Owns
 *  proving that `name`'s single call binds to a single top-level
 *  `const x = name(…)` inside the component whose value flows into exactly
 *  one JSX element, with every argument serializable — the one shape a hook
 *  cut may carry home. */
function proveHookCarve(
  ctx: CarveContext,
  statement: TS.Statement,
  name: string,
  references: readonly TS.Identifier[],
  subtreeRoots: ReadonlyArray<TS.JsxElement | TS.JsxSelfClosingElement>,
): HookCarve | undefined {
  const { ts, sf, checker, slot, componentStatement, issues } = ctx;
  const bindings = references.map((reference) => {
    const call = reference.parent;
    if (!ts.isCallExpression(call) || call.expression !== reference) return undefined;
    const declaration = call.parent;
    if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return undefined;
    const bindingStatement = declaration.parent.parent;
    return ts.isVariableStatement(bindingStatement) && withinComponent(ctx, bindingStatement)
      ? { call, bindingStatement, bindingName: declaration.name.text }
      : undefined;
  });
  const [binding] = bindings;
  if (bindings.length !== 1 || binding === undefined) {
    issues.push(`it calls ${name}(…), a hook the dialect cannot run, and not as one top-level "const x = ${name}(…)" — the cut that carries a hook home needs exactly that shape to be provable`);
    return undefined;
  }
  const valueReads: TS.Identifier[] = [];
  walk(ts, componentStatement, (node) => {
    if (ts.isIdentifier(node) && node.text === binding.bindingName && isRead(ts, node)
      && checker.getSymbolAtLocation(node)?.declarations?.[0]?.getStart(sf) === binding.bindingStatement.declarationList.declarations[0]!.getStart(sf)) {
      valueReads.push(node);
    }
  });
  let element: TS.Node | undefined = valueReads[0];
  while (element !== undefined && !ts.isJsxElement(element) && !ts.isJsxSelfClosingElement(element)) {
    element = withinComponent(ctx, element.parent) ? element.parent : undefined;
  }
  if (valueReads.length !== 1 || element === undefined || insideAny(sf, element, subtreeRoots)) {
    issues.push(`it calls ${name}(…), a hook the dialect cannot run, whose value does not flow into exactly one JSX element — no single cut can carry the hook home without changing what something else paints`);
    return undefined;
  }
  const declarationNode = ts.isFunctionDeclaration(statement) ? statement
    : ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]!.initializer : undefined;
  const parameterNames = declarationNode !== undefined && ts.isFunctionLike(declarationNode)
    ? declarationNode.parameters.map((parameter) => ts.isIdentifier(parameter.name) ? parameter.name.text : null)
    : [];
  const parameters: PropFact[] = [];
  const argumentTexts: string[] = [];
  let refused = false;
  binding.call.arguments.forEach((argument, index) => {
    const parameterName = parameterNames[index];
    const prop = typeof parameterName === "string" ? propOf(ts, checker, parameterName, checker.getTypeAtLocation(argument)) : null;
    if (prop === null) {
      issues.push(`it calls ${name}(…) with an argument that cannot ride a tree node as a prop — a hole may only be handed serializable values`);
      refused = true;
      return;
    }
    parameters.push(prop);
    argumentTexts.push(argument.getText(sf));
  });
  if (refused) return undefined;
  const wrapper = `${slot}${pascal(name.replace(/^use/u, ""))}`;
  return {
    statement, hookName: name, binding: binding.bindingStatement,
    bindingName: binding.bindingName,
    element: element as TS.JsxElement | TS.JsxSelfClosingElement,
    parameters, argumentTexts, wrapper,
  };
}

/** Free-move declarations, home-with-hole declarations, and hook-carrying
 *  cuts — the three fates a cut top-level declaration can have — decided by
 *  how the kept region still reads it. */
function classifyCutDeclarations(
  ctx: CarveContext,
  cutStatements: ReadonlySet<TS.Statement>,
  declaredNames: Map<TS.Statement, string>,
  cutRanges: TS.Node[],
  subtreeRoots: ReadonlyArray<TS.JsxElement | TS.JsxSelfClosingElement>,
): { holeDeclarations: HoleDeclaration[]; hookCarves: HookCarve[] } {
  const { ts, issues } = ctx;
  const holeDeclarations: HoleDeclaration[] = [];
  const hookCarves: HookCarve[] = [];

  for (const statement of cutStatements) {
    const name = declaredNames.get(statement)!;
    const references = keptReferences(ctx, cutRanges, name, statement);
    if (references.length === 0) continue; // pure home move: the cuts carry it
    if (references.every((reference) => tagOf(ts, reference.parent) !== undefined)) {
      holeDeclarations.push({ statement, name });
      continue;
    }
    if (!/^use[A-Z]/u.test(name)) {
      issues.push(`it reads ${name}, whose declaration cannot enter a screen — and ${name} is read as a value, so no hole can stand in for it`);
      continue;
    }
    const carve = proveHookCarve(ctx, statement, name, references, subtreeRoots);
    if (carve !== undefined) hookCarves.push(carve);
  }

  // The hook cut removes its binding and its element from the kept region, so
  // free-variable and closure scans must not read through them.
  for (const carve of hookCarves) cutRanges.push(carve.binding, carve.element);

  return { holeDeclarations, hookCarves };
}

/** A wrapper's destructured-object parameter, empty when it takes no props. */
function signatureOf(props: ReadonlyArray<PropFact>): string {
  return props.length === 0 ? "" : `{ ${props.map((prop) => prop.name).join(", ")} }: { ${
    props.map((prop) => `${prop.name}${prop.optional ? "?" : ""}: ${prop.type}`).join("; ")} }`;
}

/** The generated hole components: one per outermost unportable subtree and
 *  one per hook-carrying cut, each a plain function that returns exactly the
 *  cut JSX, its free variables closed over or threaded in as props. Rewrites
 *  the kept region's JSX to reference each hole by name in place of the cut. */
function generateWrappers(
  ctx: CarveContext,
  topLevel: Map<string, TS.Statement>,
  cutStatements: ReadonlySet<TS.Statement>,
  holeDeclarations: readonly HoleDeclaration[],
  subtreeRoots: ReadonlyArray<TS.JsxElement | TS.JsxSelfClosingElement>,
  hookCarves: readonly HookCarve[],
): { holes: string[]; edits: Edit[]; wrappers: string[]; closureSeeds: TS.Node[] } {
  const { ts, sf, source, slot } = ctx;
  const holes: string[] = holeDeclarations.map((hole) => hole.name);
  const edits: Edit[] = [];
  const wrappers: string[] = [];
  const closureSeeds: TS.Node[] = [...cutStatements];

  const holeNames = new Set<string>([...topLevel.keys(), ...holes]);
  const freshName = (base: string): string => {
    let name = base;
    for (let index = 2; holeNames.has(name); index += 1) name = `${base}${index}`;
    holeNames.add(name);
    return name;
  };

  for (const root of subtreeRoots) {
    const opening = ts.isJsxElement(root) ? root.openingElement : root;
    const scan = scanElement(ctx, root, `<${tagOf(ts, opening)}> subtree`, new Set());
    if (scan === null) continue;
    const name = freshName(`${slot}${pascal(tagOf(ts, opening) ?? "part")}`);
    holes.push(name);
    closureSeeds.push(...scan.closureSeeds);
    const propsText = scan.props.map((prop) => ` ${prop.name}={${prop.name}}`).join("");
    edits.push({ start: root.getStart(sf), end: root.end, text: `<${name}${propsText} />` });
    wrappers.push(`export function ${name}(${signatureOf(scan.props)}) {\n  return (\n    ${root.getText(sf)}\n  );\n}`);
  }

  for (const carve of hookCarves) {
    const scan = scanElement(ctx, carve.element, `${carve.hookName}(…) cut`, new Set([carve.bindingName]));
    if (scan === null) continue;
    const name = freshName(carve.wrapper);
    holes.push(name);
    closureSeeds.push(...scan.closureSeeds);
    const props = [...carve.parameters, ...scan.props];
    const propsText = [
      ...carve.parameters.map((parameter, index) => ` ${parameter.name}={${carve.argumentTexts[index]}}`),
      ...scan.props.map((prop) => ` ${prop.name}={${prop.name}}`),
    ].join("");
    edits.push({ start: carve.element.getStart(sf), end: carve.element.end, text: `<${name}${propsText} />` });
    const bindingEnd = carve.binding.end + (source[carve.binding.end] === "\n" ? 1 : 0);
    edits.push({ start: carve.binding.getStart(sf), end: bindingEnd, text: "" });
    wrappers.push([
      `export function ${name}(${signatureOf(props)}) {`,
      `  const ${carve.bindingName} = ${carve.hookName}(${carve.parameters.map((parameter) => parameter.name).join(", ")});`,
      "  return (",
      `    ${carve.element.getText(sf)}`,
      "  );",
      "}",
    ].join("\n"));
  }

  return { holes, edits, wrappers, closureSeeds };
}

/** `<button>` becomes the Kit Button — a pure tag rename on both the opening
 *  and (when present) closing tag name. */
function rewriteButtons(ctx: CarveContext, buttons: ReadonlyArray<TS.JsxElement | TS.JsxSelfClosingElement>): Edit[] {
  const { ts, sf } = ctx;
  const edits: Edit[] = [];
  for (const button of buttons) {
    const opening = ts.isJsxElement(button) ? button.openingElement : button;
    edits.push({ start: opening.tagName.getStart(sf), end: opening.tagName.end, text: "Button" });
    if (ts.isJsxElement(button)) {
      edits.push({ start: button.closingElement.tagName.getStart(sf), end: button.closingElement.tagName.end, text: "Button" });
    }
    // `type` is dropped, not carried: outside a form it only suppressed the
    // submit default, and the Kit Button already defaults to type="button".
    const typeAttribute = opening.attributes.properties.find((attribute) =>
      ts.isJsxAttribute(attribute) && ts.isIdentifier(attribute.name) && attribute.name.text === "type");
    if (typeAttribute !== undefined) edits.push({ start: typeAttribute.getFullStart(), end: typeAttribute.end, text: "" });
  }
  return edits;
}

/** The same law as the tag rewrite, applied to style KEYS: `background`
 *  becomes `backgroundColor` — a pure rename, and a value only the shorthand
 *  could smuggle (a url(), a gradient) is inert under the longhand — and a
 *  key the allowlist does not carry is REMOVED, never guessed at. No value is
 *  ever inspected. Only literal keys in the kept region are touched; anything
 *  computed is left for the gauntlet to refuse by name. */
function narrowInlineStyles(ctx: CarveContext, cutRanges: ReadonlyArray<TS.Node>): Edit[] {
  const { ts, sf, componentStatement } = ctx;
  const SAFE_KEYS: ReadonlySet<string> = new Set(SAFE_STYLE_PROPERTIES);
  const edits: Edit[] = [];
  walk(ts, componentStatement, (node) => {
    if (insideAny(sf, node, cutRanges)) return false;
    if (!ts.isJsxAttribute(node) || !ts.isIdentifier(node.name) || node.name.text !== "style") return;
    const value = node.initializer;
    if (value === undefined || !ts.isJsxExpression(value) || value.expression === undefined
      || !ts.isObjectLiteralExpression(value.expression)) return;
    const properties = value.expression.properties;
    properties.forEach((property, index) => {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return;
      const key = property.name.text;
      if (key === "background") {
        edits.push({ start: property.name.getStart(sf), end: property.name.end, text: "backgroundColor" });
        return;
      }
      if (SAFE_KEYS.has(key)) return;
      const next = properties[index + 1];
      edits.push(next !== undefined
        ? { start: property.getStart(sf), end: next.getStart(sf), text: "" }
        : { start: property.getFullStart(), end: property.end, text: "" });
    });
    return undefined;
  });
  return edits;
}

/** Walks outward from the cut's own closure seeds to every top-level
 *  declaration and import the home module must carry, transitively — a
 *  helper the cut reads can itself read another helper. */
function collectHomeClosure(
  ctx: CarveContext,
  topLevel: Map<string, TS.Statement>,
  cutStatements: ReadonlySet<TS.Statement>,
  closureSeeds: readonly TS.Node[],
): { homeStatements: Set<TS.Statement>; homeImports: Map<string, TS.ImportDeclaration> } {
  const { ts, sf, checker, componentStatement } = ctx;
  const homeStatements = new Set<TS.Statement>(cutStatements);
  const homeImports = new Map<string, TS.ImportDeclaration>();
  const queue = [...closureSeeds];
  while (queue.length > 0) {
    const seed = queue.pop()!;
    walk(ts, seed, (node) => {
      if (!ts.isIdentifier(node)) return;
      const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
      if (declaration === undefined || declaration.getSourceFile() !== sf) return;
      const statement = topLevelStatementOf(ts, declaration);
      if (statement === undefined || statement === componentStatement) return;
      if (ts.isImportDeclaration(statement)) {
        homeImports.set(node.text, statement);
        return;
      }
      if (topLevel.get(node.text) !== statement || homeStatements.has(statement)) return;
      homeStatements.add(statement);
      queue.push(statement);
    });
  }
  return { homeStatements, homeImports };
}

/** MOVED, not copied, once nothing in the port still reads it: a dead
 *  module-level line still RUNS at the screen's boot, and one that reads what
 *  only the host has — `new Intl.NumberFormat(…)` feeding a chart that just
 *  went home — takes the whole port down. A declaration both halves read
 *  stays in both; consts duplicate safely. Fixpoint, because pruning a helper
 *  can orphan the helper it read. */
function pruneDeadHomeStatements(
  ctx: CarveContext,
  homeStatements: ReadonlySet<TS.Statement>,
  cutStatements: ReadonlySet<TS.Statement>,
  cutRanges: readonly TS.Node[],
  declaredNames: Map<TS.Statement, string>,
): { pruned: Set<TS.Statement>; edits: Edit[] } {
  const { ts, sf, checker, source } = ctx;
  const pruned = new Set<TS.Statement>();
  const keptOut = (node: TS.Node): boolean =>
    insideAny(sf, node, cutRanges) || insideAny(sf, node, [...pruned]);
  for (let moved = true; moved;) {
    moved = false;
    for (const statement of homeStatements) {
      if (cutStatements.has(statement) || pruned.has(statement)) continue;
      const name = declaredNames.get(statement);
      if (name === undefined) continue;
      let read = false;
      walk(ts, sf, (node) => {
        if (read || !ts.isIdentifier(node) || node.text !== name || !isRead(ts, node) || keptOut(node)) return;
        if (node.getStart(sf) >= statement.getStart(sf) && node.end <= statement.end) return;
        const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
        if (declaration !== undefined && topLevelStatementOf(ts, declaration) === statement) read = true;
      });
      if (!read) {
        pruned.add(statement);
        moved = true;
      }
    }
  }
  const edits: Edit[] = [];
  for (const statement of pruned) {
    const end = statement.end + (source[statement.end] === "\n" ? 1 : 0);
    edits.push({ start: statement.getStart(sf), end, text: "" });
  }
  return { pruned, edits };
}

/** The home file's imports: exactly the original bindings its code reads,
 *  regrouped per module, type-only imports staying type-only. */
function homeImportLines(ts: typeof TS, homeImports: Map<string, TS.ImportDeclaration>): string[] {
  const groups = new Map<string, { values: string[]; types: string[]; defaultName?: string }>();
  for (const [local, statement] of homeImports) {
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause === undefined) continue;
    const specifier = statement.moduleSpecifier.text;
    const group = groups.get(specifier) ?? { values: [], types: [] };
    groups.set(specifier, group);
    const clause = statement.importClause;
    if (clause.name?.text === local) group.defaultName = local;
    const named = clause.namedBindings;
    if (named !== undefined && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        if (element.name.text !== local) continue;
        const text = element.propertyName === undefined ? local : `${element.propertyName.text} as ${local}`;
        (clause.isTypeOnly || element.isTypeOnly ? group.types : group.values).push(text);
      }
    }
  }
  return [...groups.entries()].flatMap(([specifier, group]) => [
    ...(group.defaultName === undefined ? [] : [`import ${group.defaultName} from ${JSON.stringify(specifier)};`]),
    ...(group.values.length === 0 ? [] : [`import { ${group.values.sort().join(", ")} } from ${JSON.stringify(specifier)};`]),
    ...(group.types.length === 0 ? [] : [`import type { ${group.types.sort().join(", ")} } from ${JSON.stringify(specifier)};`]),
  ]);
}

/** Whether a hole's own declaration is already `export`ed, so the home
 *  module does not need a redundant re-export for it. */
function exportedAlready(ts: typeof TS, statement: TS.Statement): boolean {
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

/** The generated home module: the cut declarations, their module-level
 *  closure, the generated wrappers, and exactly the imports those need.
 *  `undefined` when nothing was cut into a hole. */
function buildHomeModule(
  ctx: CarveContext,
  topLevel: Map<string, TS.Statement>,
  cutStatements: ReadonlySet<TS.Statement>,
  cutRanges: readonly TS.Node[],
  closureSeeds: readonly TS.Node[],
  declaredNames: Map<TS.Statement, string>,
  holeDeclarations: readonly HoleDeclaration[],
  wrappers: readonly string[],
  holes: readonly string[],
): { home: string | undefined; edits: Edit[] } {
  const { ts, sf, slot } = ctx;
  const { homeStatements, homeImports } = collectHomeClosure(ctx, topLevel, cutStatements, closureSeeds);
  const { edits } = pruneDeadHomeStatements(ctx, homeStatements, cutStatements, cutRanges, declaredNames);

  const reExports = holeDeclarations
    .filter((hole) => !exportedAlready(ts, hole.statement))
    .map((hole) => hole.name);

  // The host wrote a client module, and the cut half still is one: the wiring
  // rides into server import graphs, and hooks without the directive are what
  // Next refuses there.
  const [firstStatement] = sf.statements;
  const directive = firstStatement !== undefined && ts.isExpressionStatement(firstStatement)
    && ts.isStringLiteral(firstStatement.expression)
    && (firstStatement.expression.text === "use client" || firstStatement.expression.text === "use server")
    ? `"${firstStatement.expression.text}";`
    : undefined;

  const home = holes.length === 0 ? undefined : [
    ...(directive === undefined ? [] : [directive]),
    "// Generated by `vendo sync` — do not edit. Regenerated on every sync.",
    `// The unportable half of ${slot}: cut from the host's component and rendered`,
    "// natively as holes; the port references these by name.",
    ...homeImportLines(ts, homeImports),
    "",
    ...[...homeStatements]
      .sort((left, right) => left.getStart(sf) - right.getStart(sf))
      .map((statement) => statement.getText(sf)),
    ...wrappers,
    ...(reExports.length === 0 ? [] : [`export { ${reExports.sort().join(", ")} };`]),
    "",
  ].join("\n");

  return { home, edits };
}

/** Removes every cut top-level statement from the kept region, then applies
 *  every edit (subtree/hook rewrites, button renames, style narrowing, dead
 *  home-statement removal, cut removal) back-to-front so earlier offsets stay
 *  valid. */
function applyCarveEdits(ctx: CarveContext, cutStatements: ReadonlySet<TS.Statement>, edits: Edit[]): string {
  const { sf, source } = ctx;
  const allEdits = [...edits];
  for (const statement of cutStatements) {
    const end = statement.end + (source[statement.end] === "\n" ? 1 : 0);
    allEdits.push({ start: statement.getStart(sf), end, text: "" });
  }
  let carved = source;
  for (const edit of allEdits.sort((left, right) => right.start - left.start)) {
    carved = carved.slice(0, edit.start) + edit.text + carved.slice(edit.end);
  }
  return carved;
}

export function carveModule(slot: string, source: string, file: string): CarveResult {
  const parsed = parseModuleSource(source, file);
  if (!parsed) return untouched(source);
  const { ts } = parsed;

  const checked = resolveCheckedSourceFile(ts, file, source);
  if (checked === undefined) return untouched(source);
  const { sf, checker } = checked;

  // ---- the module's top level ----------------------------------------------

  const found = findComponentDeclaration(ts, sf, slot);
  if (found === undefined) return untouched(source);
  const { topLevel, componentStatement } = found;

  const issues: string[] = [];
  const ctx: CarveContext = { ts, sf, checker, source, slot, componentStatement, issues };

  // ---- the cut set -----------------------------------------------------------

  const cutSet = computeCutSet(ctx, topLevel);
  if (cutSet === undefined) {
    // Nothing to carve — but the style narrowing is not the carver's reward,
    // it is every port's due: a plain card whose only sin is `background:`
    // must not stay refused because it gave the carver nothing else to do.
    const styleEdits = narrowInlineStyles(ctx, []);
    if (styleEdits.length === 0) return untouched(source);
    return { source: applyCarveEdits(ctx, new Set(), styleEdits), holes: [], button: false, issues: [] };
  }
  const { cutStatements, subtreeRoots, buttons } = cutSet;

  const cutRanges: TS.Node[] = [...cutStatements, ...subtreeRoots];

  // ---- how each cut declaration is consumed ---------------------------------

  const declaredNames = new Map<TS.Statement, string>();
  for (const [name, statement] of topLevel) declaredNames.set(statement, name);

  // ---- classify the cut declarations ----------------------------------------

  const { holeDeclarations, hookCarves } = classifyCutDeclarations(ctx, cutStatements, declaredNames, cutRanges, subtreeRoots);

  // ---- the generated wrappers ------------------------------------------------

  const generated = generateWrappers(ctx, topLevel, cutStatements, holeDeclarations, subtreeRoots, hookCarves);

  if (issues.length > 0) return { source, holes: [], button: false, issues };

  // ---- the buttons -----------------------------------------------------------

  const buttonEdits = rewriteButtons(ctx, buttons);

  // ---- the inline styles, narrowed to the paint allowlist -------------------

  const styleEdits = narrowInlineStyles(ctx, cutRanges);

  // ---- the home module's closure and imports --------------------------------

  const { home, edits: prunedEdits } = buildHomeModule(
    ctx, topLevel, cutStatements, cutRanges, generated.closureSeeds,
    declaredNames, holeDeclarations, generated.wrappers, generated.holes,
  );

  // ---- apply -----------------------------------------------------------------

  const edits = [...generated.edits, ...buttonEdits, ...styleEdits, ...prunedEdits];
  const carved = applyCarveEdits(ctx, cutStatements, edits);

  return { source: carved, holes: generated.holes, home, button: buttons.length > 0, issues };
}
