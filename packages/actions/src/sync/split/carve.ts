import path from "node:path";
import { DISPLAY_TAG_NAMES } from "@vendoai/apps/contract";
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

export function carveModule(slot: string, source: string, file: string): CarveResult {
  const parsed = parseModuleSource(source, file);
  if (!parsed) return untouched(source);
  const { ts } = parsed;

  // The host's own compiler over the host's own file: symbol resolution is what
  // separates "reads a browser API" from "reads its own helper", and the local
  // types are what let a free variable become a typed prop. Imports that do not
  // resolve cost nothing — every question asked here is about THIS module.
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
    return untouched(source);
  }
  const sf = program.getSourceFile(file);
  // A capture that drifted from the file on disk is not this module: carve
  // nothing, and let the gauntlet say why the naive port refuses.
  if (sf === undefined || sf.text !== source) return untouched(source);
  const checker = program.getTypeChecker();

  const issues: string[] = [];

  // ---- the module's top level ----------------------------------------------

  /** Named top-level statements, by name: the cut candidates and the closure. */
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
  if (componentStatement === undefined) return untouched(source);

  const topLevelStatementOf = (node: TS.Node): TS.Statement | undefined => {
    let at: TS.Node = node;
    while (at.parent !== undefined && !ts.isSourceFile(at.parent)) at = at.parent;
    return at.parent !== undefined && ts.isSourceFile(at.parent) ? at as TS.Statement : undefined;
  };

  // ---- what is unportable, asked structurally -------------------------------

  const tagOf = (node: TS.Node): string | undefined =>
    (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)
      ? node.tagName.text
      : undefined;
  const unportableTag = (tag: string | undefined): boolean =>
    tag !== undefined && /^[a-z]/u.test(tag) && !PORTABLE_TAGS.has(tag);

  /** A name in reading position — never a property's own name, an attribute's,
   *  or a declaration's. Those belong to their object or their declaration; a
   *  READ is what makes a scope demand the name exist. */
  const isRead = (id: TS.Identifier): boolean => {
    const parent = id.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
    if (ts.isJsxAttribute(parent)) return false;
    if (ts.isPropertySignature(parent) && parent.name === id) return false;
    if ((ts.isFunctionDeclaration(parent) || ts.isParameter(parent) || ts.isVariableDeclaration(parent)
      || ts.isBindingElement(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent))
      && (parent as { name?: TS.Node }).name === id) return false;
    return true;
  };

  /** A name the gauntlet's ES-only lib refuses with "does not exist inside a
   *  screen": every declaration is the ENVIRONMENT's (a default lib, or an
   *  ambient @types package like node's — `performance` is declared by both),
   *  and none is the ES lib's own. The host's module scope and its imports are
   *  never environment, so a host helper shadowing a global stays portable. */
  const domOnly = (id: TS.Identifier): boolean => {
    if (!isRead(id)) return false;
    const declarations = checker.getSymbolAtLocation(id)?.declarations ?? [];
    if (declarations.length === 0) return false;
    const libNames = declarations.map((declaration) => path.basename(declaration.getSourceFile().fileName));
    const ambient = declarations.every((declaration, index) =>
      libNames[index]!.startsWith("lib.") || declaration.getSourceFile().fileName.includes("/node_modules/"));
    return ambient && !libNames.some((name) => name.startsWith("lib.es"));
  };

  const walk = (root: TS.Node, visit: (node: TS.Node) => boolean | void): void => {
    const step = (node: TS.Node): void => {
      if (visit(node) === false) return;
      ts.forEachChild(node, step);
    };
    step(root);
  };

  const statementIsUnportable = (statement: TS.Statement): boolean => {
    let hit = false;
    walk(statement, (node) => {
      if (unportableTag(tagOf(node))) hit = true;
      if (ts.isIdentifier(node) && domOnly(node)) hit = true;
    });
    return hit;
  };

  // ---- the cut set -----------------------------------------------------------

  const cutStatements = new Set<TS.Statement>();
  for (const [name, statement] of topLevel) {
    if (statement === componentStatement || name === slot) continue;
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
    if (statementIsUnportable(statement)) cutStatements.add(statement);
  }

  /** The component's own JSX: the outermost unportable elements (cut whole, so
   *  everything under them goes home together) and the buttons OUTSIDE them
   *  (a button inside a cut renders at home as the host's own element). */
  const subtreeRoots: Array<TS.JsxElement | TS.JsxSelfClosingElement> = [];
  const buttons: Array<TS.JsxElement | TS.JsxSelfClosingElement> = [];
  walk(componentStatement, (node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = tagOf(opening);
      if (unportableTag(tag)) {
        subtreeRoots.push(node);
        return false;
      }
      if (tag === "button") buttons.push(node);
    }
    return undefined;
  });

  if (cutStatements.size === 0 && subtreeRoots.length === 0 && buttons.length === 0) return untouched(source);

  const insideAny = (node: TS.Node, ranges: ReadonlyArray<TS.Node>): boolean =>
    ranges.some((range) => node.getStart(sf) >= range.getStart(sf) && node.end <= range.end);
  const cutRanges: TS.Node[] = [...cutStatements, ...subtreeRoots];

  // ---- how each cut declaration is consumed ---------------------------------

  const declaredNames = new Map<TS.Statement, string>();
  for (const [name, statement] of topLevel) declaredNames.set(statement, name);

  /** Kept-region references to `name`, by symbol identity with its declaration. */
  const keptReferences = (name: string, statement: TS.Statement): TS.Identifier[] => {
    const references: TS.Identifier[] = [];
    walk(sf, (node) => {
      if (!ts.isIdentifier(node) || node.text !== name || !isRead(node)) return;
      if (insideAny(node, cutRanges)) return;
      const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
      if (declaration !== undefined && topLevelStatementOf(declaration) === statement) references.push(node);
    });
    return references;
  };

  interface HookCarve {
    statement: TS.Statement;
    hookName: string;
    binding: TS.VariableStatement;
    bindingName: string;
    element: TS.JsxElement | TS.JsxSelfClosingElement;
    parameters: Array<{ name: string; type: string; optional: boolean }>;
    argumentTexts: string[];
    wrapper: string;
  }
  const holeDeclarations: Array<{ statement: TS.Statement; name: string }> = [];
  const hookCarves: HookCarve[] = [];

  // ---- serializable types, proven by the host's checker ---------------------

  const jsonTypeText = (type: TS.Type, depth = 0): string | null => {
    const base = checker.getBaseTypeOfLiteralType(type);
    const flags = base.getFlags();
    if (flags & ts.TypeFlags.String) return "string";
    if (flags & ts.TypeFlags.Number) return "number";
    if (flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) return "boolean";
    if (flags & ts.TypeFlags.Null) return "null";
    if (flags & ts.TypeFlags.Undefined) return "undefined";
    if (base.isUnion()) {
      const parts = base.types.map((member) => jsonTypeText(member, depth));
      if (parts.some((part) => part === null)) return null;
      return [...new Set(parts as string[])].join(" | ");
    }
    if (checker.isArrayType(base)) {
      const [element] = checker.getTypeArguments(base as TS.TypeReference);
      const inner = element === undefined ? null : jsonTypeText(element, depth + 1);
      return inner === null ? null : (inner.includes(" ") ? `Array<${inner}>` : `${inner}[]`);
    }
    if (flags & ts.TypeFlags.Object && depth < 3) {
      const properties = base.getProperties();
      if (properties.length === 0) return null;
      const fields = properties.map((property) => {
        const declaration = property.declarations?.[0];
        if (declaration === undefined) return null;
        const inner = jsonTypeText(checker.getTypeOfSymbolAtLocation(property, declaration), depth + 1);
        return inner === null ? null : `${property.name}: ${inner}`;
      });
      if (fields.some((field) => field === null)) return null;
      return `{ ${fields.join("; ")} }`;
    }
    return null;
  };

  /** A prop off a checked type: `T | undefined` prints as an optional `T`. */
  const propOf = (name: string, type: TS.Type): { name: string; type: string; optional: boolean } | null => {
    const text = jsonTypeText(type);
    if (text === null) return null;
    const parts = text.split(" | ").filter((part) => part !== "undefined");
    return parts.length === 0 ? null : { name, type: parts.join(" | "), optional: parts.length !== text.split(" | ").length };
  };

  // ---- free variables of an element → props + closure needs -----------------

  const withinComponent = (node: TS.Node): boolean =>
    node.getStart(sf) >= componentStatement.getStart(sf) && node.end <= componentStatement.end;

  interface ElementScan {
    props: Array<{ name: string; type: string; optional: boolean }>;
    closureSeeds: TS.Node[];
  }

  const scanElement = (
    element: TS.Node,
    what: string,
    exclude: ReadonlySet<string>,
  ): ElementScan | null => {
    const props: Array<{ name: string; type: string; optional: boolean }> = [];
    const closureSeeds: TS.Node[] = [];
    let refused = false;
    walk(element, (node) => {
      if (!ts.isIdentifier(node) || !isRead(node) || exclude.has(node.text)) return;
      const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
      if (declaration === undefined) return; // a global — it resolves at home
      if (declaration.getStart(sf) >= element.getStart(sf) && declaration.end <= element.end
        && declaration.getSourceFile() === sf) return; // bound inside the cut
      const home = topLevelStatementOf(declaration);
      if (declaration.getSourceFile() !== sf || home === undefined) return;
      if (ts.isImportDeclaration(home) || home !== componentStatement) {
        closureSeeds.push(node);
        return;
      }
      // Declared in the component, read by the cut: it crosses as a PROP, so it
      // must be a value a tree node can carry.
      if (tagOf(node.parent) !== undefined) {
        issues.push(`its ${what} renders <${node.text}>, a component declared inside ${slot} itself — a hole cannot carry one`);
        refused = true;
        return;
      }
      if (props.some((prop) => prop.name === node.text)) return;
      const prop = propOf(node.text, checker.getTypeAtLocation(node));
      if (prop === null) {
        issues.push(`its ${what} reads ${node.text} from ${slot}'s own scope, and ${node.text}'s type cannot ride a tree node as a prop — a hole may only be handed serializable values`);
        refused = true;
        return;
      }
      props.push(prop);
    });
    return refused ? null : { props, closureSeeds };
  };

  // ---- classify the cut declarations ----------------------------------------

  for (const statement of cutStatements) {
    const name = declaredNames.get(statement)!;
    const references = keptReferences(name, statement);
    if (references.length === 0) continue; // pure home move: the cuts carry it
    if (references.every((reference) => tagOf(reference.parent) !== undefined)) {
      holeDeclarations.push({ statement, name });
      continue;
    }
    if (!/^use[A-Z]/u.test(name)) {
      issues.push(`it reads ${name}, whose declaration cannot enter a screen — and ${name} is read as a value, so no hole can stand in for it`);
      continue;
    }
    // THE HOOK-CARRYING GUARD. Provable, never heuristic; any miss refuses.
    const bindings = references.map((reference) => {
      const call = reference.parent;
      if (!ts.isCallExpression(call) || call.expression !== reference) return undefined;
      const declaration = call.parent;
      if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return undefined;
      const bindingStatement = declaration.parent.parent;
      return ts.isVariableStatement(bindingStatement) && withinComponent(bindingStatement)
        ? { call, bindingStatement, bindingName: declaration.name.text }
        : undefined;
    });
    const [binding] = bindings;
    if (bindings.length !== 1 || binding === undefined) {
      issues.push(`it calls ${name}(…), a hook the dialect cannot run, and not as one top-level "const x = ${name}(…)" — the cut that carries a hook home needs exactly that shape to be provable`);
      continue;
    }
    const valueReads: TS.Identifier[] = [];
    walk(componentStatement, (node) => {
      if (ts.isIdentifier(node) && node.text === binding.bindingName && isRead(node)
        && checker.getSymbolAtLocation(node)?.declarations?.[0]?.getStart(sf) === binding.bindingStatement.declarationList.declarations[0]!.getStart(sf)) {
        valueReads.push(node);
      }
    });
    let element: TS.Node | undefined = valueReads[0];
    while (element !== undefined && !ts.isJsxElement(element) && !ts.isJsxSelfClosingElement(element)) {
      element = withinComponent(element.parent) ? element.parent : undefined;
    }
    if (valueReads.length !== 1 || element === undefined || insideAny(element, subtreeRoots)) {
      issues.push(`it calls ${name}(…), a hook the dialect cannot run, whose value does not flow into exactly one JSX element — no single cut can carry the hook home without changing what something else paints`);
      continue;
    }
    const declarationNode = ts.isFunctionDeclaration(statement) ? statement
      : ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]!.initializer : undefined;
    const parameterNames = declarationNode !== undefined && ts.isFunctionLike(declarationNode)
      ? declarationNode.parameters.map((parameter) => ts.isIdentifier(parameter.name) ? parameter.name.text : null)
      : [];
    const parameters: Array<{ name: string; type: string; optional: boolean }> = [];
    const argumentTexts: string[] = [];
    let refused = false;
    binding.call.arguments.forEach((argument, index) => {
      const parameterName = parameterNames[index];
      const prop = typeof parameterName === "string" ? propOf(parameterName, checker.getTypeAtLocation(argument)) : null;
      if (prop === null) {
        issues.push(`it calls ${name}(…) with an argument that cannot ride a tree node as a prop — a hole may only be handed serializable values`);
        refused = true;
        return;
      }
      parameters.push(prop);
      argumentTexts.push(argument.getText(sf));
    });
    if (refused) continue;
    const wrapper = `${slot}${pascal(name.replace(/^use/u, ""))}`;
    hookCarves.push({
      statement, hookName: name, binding: binding.bindingStatement,
      bindingName: binding.bindingName,
      element: element as TS.JsxElement | TS.JsxSelfClosingElement,
      parameters, argumentTexts, wrapper,
    });
  }

  // The hook cut removes its binding and its element from the kept region, so
  // free-variable and closure scans must not read through them.
  for (const carve of hookCarves) cutRanges.push(carve.binding, carve.element);

  // ---- the generated wrappers ------------------------------------------------

  const holes: string[] = holeDeclarations.map((hole) => hole.name);
  const edits: Edit[] = [];
  const wrappers: string[] = [];
  const closureSeeds: TS.Node[] = [...cutStatements];

  const signatureOf = (props: ReadonlyArray<{ name: string; type: string; optional: boolean }>): string =>
    props.length === 0 ? "" : `{ ${props.map((prop) => prop.name).join(", ")} }: { ${
      props.map((prop) => `${prop.name}${prop.optional ? "?" : ""}: ${prop.type}`).join("; ")} }`;

  const holeNames = new Set<string>([...topLevel.keys(), ...holes]);
  const freshName = (base: string): string => {
    let name = base;
    for (let index = 2; holeNames.has(name); index += 1) name = `${base}${index}`;
    holeNames.add(name);
    return name;
  };

  for (const root of subtreeRoots) {
    const opening = ts.isJsxElement(root) ? root.openingElement : root;
    const scan = scanElement(root, `<${tagOf(opening)}> subtree`, new Set());
    if (scan === null) continue;
    const name = freshName(`${slot}${pascal(tagOf(opening) ?? "part")}`);
    holes.push(name);
    closureSeeds.push(...scan.closureSeeds);
    const propsText = scan.props.map((prop) => ` ${prop.name}={${prop.name}}`).join("");
    edits.push({ start: root.getStart(sf), end: root.end, text: `<${name}${propsText} />` });
    wrappers.push(`export function ${name}(${signatureOf(scan.props)}) {\n  return (\n    ${root.getText(sf)}\n  );\n}`);
  }

  for (const carve of hookCarves) {
    const scan = scanElement(carve.element, `${carve.hookName}(…) cut`, new Set([carve.bindingName]));
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

  if (issues.length > 0) return { source, holes: [], button: false, issues };

  // ---- the buttons -----------------------------------------------------------

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

  // ---- the home module's closure and imports --------------------------------

  const homeStatements = new Set<TS.Statement>(cutStatements);
  const homeImports = new Map<string, TS.ImportDeclaration>();
  const queue = [...closureSeeds];
  while (queue.length > 0) {
    const seed = queue.pop()!;
    walk(seed, (node) => {
      if (!ts.isIdentifier(node)) return;
      const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
      if (declaration === undefined || declaration.getSourceFile() !== sf) return;
      const statement = topLevelStatementOf(declaration);
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

  // MOVED, not copied, once nothing in the port still reads it: a dead
  // module-level line still RUNS at the screen's boot, and one that reads what
  // only the host has — `new Intl.NumberFormat(…)` feeding a chart that just
  // went home — takes the whole port down. A declaration both halves read
  // stays in both; consts duplicate safely. Fixpoint, because pruning a helper
  // can orphan the helper it read.
  const pruned = new Set<TS.Statement>();
  const keptOut = (node: TS.Node): boolean =>
    insideAny(node, cutRanges) || insideAny(node, [...pruned]);
  for (let moved = true; moved;) {
    moved = false;
    for (const statement of homeStatements) {
      if (cutStatements.has(statement) || pruned.has(statement)) continue;
      const name = declaredNames.get(statement);
      if (name === undefined) continue;
      let read = false;
      walk(sf, (node) => {
        if (read || !ts.isIdentifier(node) || node.text !== name || !isRead(node) || keptOut(node)) return;
        if (node.getStart(sf) >= statement.getStart(sf) && node.end <= statement.end) return;
        const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
        if (declaration !== undefined && topLevelStatementOf(declaration) === statement) read = true;
      });
      if (!read) {
        pruned.add(statement);
        moved = true;
      }
    }
  }
  for (const statement of pruned) {
    const end = statement.end + (source[statement.end] === "\n" ? 1 : 0);
    edits.push({ start: statement.getStart(sf), end, text: "" });
  }

  /** The home file's imports: exactly the original bindings its code reads,
   *  regrouped per module, type-only imports staying type-only. */
  const importLines = (): string[] => {
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
  };

  const exportedAlready = (statement: TS.Statement): boolean =>
    ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const reExports = holeDeclarations
    .filter((hole) => !exportedAlready(hole.statement))
    .map((hole) => hole.name);

  const home = holes.length === 0 ? undefined : [
    "// Generated by `vendo sync` — do not edit. Regenerated on every sync.",
    `// The unportable half of ${slot}: cut from the host's component and rendered`,
    "// natively as holes; the port references these by name.",
    ...importLines(),
    "",
    ...[...homeStatements]
      .sort((left, right) => left.getStart(sf) - right.getStart(sf))
      .map((statement) => statement.getText(sf)),
    ...wrappers,
    ...(reExports.length === 0 ? [] : [`export { ${reExports.sort().join(", ")} };`]),
    "",
  ].join("\n");

  // ---- apply -----------------------------------------------------------------

  for (const statement of cutStatements) {
    const end = statement.end + (source[statement.end] === "\n" ? 1 : 0);
    edits.push({ start: statement.getStart(sf), end, text: "" });
  }
  let carved = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    carved = carved.slice(0, edit.start) + edit.text + carved.slice(edit.end);
  }

  return { source: carved, holes, home, button: buttons.length > 0, issues };
}
