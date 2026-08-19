import type TS from "typescript";
import { defaultExportOf } from "../capture.js";
import { parseModuleSource, visitNodes } from "../common.js";

/**
 * The PORTED half: the host's own component, rewritten into the screen dialect.
 *
 * The body is the host's, byte for byte. Only the module's IMPORTS move, and
 * every one of them moves the same way: the host's local name survives as a
 * generated SHIM, so a call the host wrote (`useRewards(accountId)`) still
 * reads exactly like that in the port while its body becomes the one capability
 * the dialect has. A remix is edited by a model, and a model that has to
 * re-derive the host's call sites is a model rewriting working code.
 *
 * Placement is ALL-OR-NOTHING per import statement, and that is the whole
 * conservatism of this file: one binding the port cannot place leaves the
 * statement written as the host wrote it, so the gauntlet refuses the port and
 * NAMES the module. There is no second, cheaper opinion about what is portable
 * here — the check that governs a remix at save time is the check that decides
 * whether one can exist.
 */

/** One host import the port replaced with a generated capability. */
export interface PortBinding {
  /** The local name the host wrote — the port keeps calling it by that name. */
  name: string;
  /** The name its module exports it under; "default" for a default import. */
  imported: string;
  /** The specifier the host wrote, for the caller to resolve. */
  specifier: string;
}

export interface Port {
  /** Every render-time read, bundled into ONE envelope tool: the engine resolves
   *  a screen's data as one result per tool, so a component's reads have to
   *  arrive together or they cannot all be served. `arity` is the widest CALL
   *  the host component makes of each hook — the same ceiling the writes carry. */
  read?: { tool: string; bindings: Array<PortBinding & { arity: number }> };
  /** One intent per action binding — reachable only from a handler. `arity` is
   *  the widest CALL the host component actually makes, which is the ceiling on
   *  what the generated tool may accept. */
  writes: Array<{ tool: string; binding: PortBinding; arity: number }>;
  holes: PortBinding[];
  /** The host's own module with its imports cut out, and the default export the
   *  dialect needs. Kept apart from the shims because a shim cannot be written
   *  until the host's SIGNATURE is resolved — see {@link renderPort}. */
  body: string;
  trailer: string;
}

const SCREEN_MODULE = "@vendo/screen";

/** `RewardsPanel` -> `rewards_panel`, `payBill` -> `pay_bill`. */
export const snakeName = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/[^A-Za-z0-9]+/gu, "_").toLowerCase();

export const readToolName = (slot: string): string => `${snakeName(slot)}_data`;
export const writeToolName = (slot: string, binding: string): string =>
  `${snakeName(slot)}_${snakeName(binding)}`;

interface Candidate extends PortBinding { statement: TS.ImportDeclaration }

/**
 * The React hook convention — the only render-time call a port turns into a
 * data envelope.
 *
 * Without it, EVERY imported function called while rendering reads as a fetch,
 * and the ones that actually are called while rendering are mostly pure helpers:
 * `cn(...)`, `formatUSD(...)`, `titleForPath(...)`. Made an envelope, `cn` returns
 * undefined, the component paints with no classes, and the gauntlet sees a screen
 * that is entirely legal — a rest parameter walks past the needs-arguments gate
 * too. A helper that is not a hook is left un-placed instead, so its import stays
 * and the port is refused by NAME.
 *
 * A name test, and deliberately so: it only ever DENIES an envelope (the same
 * direction as `PLUMBING_HOOK` in seeds.ts), so a miss costs a refusal, never a
 * capability. It is not a boundary.
 */
const HOOK_NAME = /^use[A-Z]/u;

/** The declaration this module gives `slot`, as the node that OWNS the render:
 *  a call whose nearest enclosing function is this one runs on every paint, and
 *  a call anywhere else runs when a person does something. */
function componentOf(ts: typeof TS, sf: TS.SourceFile, slot: string): TS.Node | undefined {
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === slot) return statement;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === slot && declaration.initializer !== undefined) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
}

/**
 * The functions a JSX `on*` attribute hands to a component — the ONLY place a
 * port may call a host action from.
 *
 * The tempting rule, "any call not in the component body is a handler call", is
 * wrong in the most ordinary code there is: the arrow inside `rows.map(...)` is
 * not the component's own function either, so a pure formatter called in a list
 * becomes an async write intent, the screen paints a Promise, and NOTHING
 * refuses it — the gauntlet reads a legal screen. A silently wrong port is worse
 * than no port, so the render/handler line is drawn where it actually is.
 */
function handlerRoots(ts: typeof TS, sf: TS.SourceFile): Set<TS.Node> {
  const roots = new Set<TS.Node>();
  const add = (node: TS.Node): void => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) roots.add(node);
  };
  visitNodes(ts, sf, (node) => {
    if (!ts.isJsxAttribute(node) || !ts.isIdentifier(node.name) || !/^on[A-Z]/u.test(node.name.text)) return;
    const initializer = node.initializer;
    if (initializer === undefined || !ts.isJsxExpression(initializer) || initializer.expression === undefined) return;
    add(initializer.expression);
    visitNodes(ts, initializer.expression, add);
  });
  return roots;
}

/** Null when the host's compiler could not read the module — never a guess. */
export function portComponent(slot: string, source: string, file: string): Port | null {
  const parsed = parseModuleSource(source, file);
  if (!parsed) return null;
  const { ts, sf } = parsed;

  const erase = new Set<TS.ImportDeclaration>();
  const candidates = new Map<TS.ImportDeclaration, Candidate[]>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    // A type-only import and a side-effect import both carry no capability, and
    // neither exists inside the VM. What a dropped type breaks, the type check
    // says out loud. This is decided BEFORE the react rule below, because
    // `import type { ReactNode } from "react"` is a type import that happens to
    // name react: kept, it asks the dialect's React shim for an export the shim
    // does not have, and the port dies over a binding that erases to nothing.
    if (clause === undefined || clause.isTypeOnly) { erase.add(statement); continue; }
    // `react` is the one module a port keeps: the dialect's hook subset lives
    // there, and a hook outside it is the type check's refusal to make.
    if (specifier === "react") continue;
    const bindings: Candidate[] = [];
    if (clause.name !== undefined) bindings.push({ name: clause.name.text, imported: "default", specifier, statement });
    const named = clause.namedBindings;
    // A namespace import names no single capability, so it never places.
    if (named !== undefined && !ts.isNamedImports(named)) continue;
    for (const element of named?.elements ?? []) {
      if (element.isTypeOnly) continue;
      bindings.push({ name: element.name.text, imported: (element.propertyName ?? element.name).text, specifier, statement });
    }
    candidates.set(statement, bindings);
  }

  const component = componentOf(ts, sf, slot);
  const handlers = handlerRoots(ts, sf);
  const tags = new Set<string>();
  const renderCalls = new Set<string>();
  const handlerCalls = new Set<string>();
  const arity = new Map<string, number>();
  const walk = (node: TS.Node, enclosing: TS.Node | undefined, inHandler: boolean): void => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ts.isIdentifier(node.tagName)) {
      tags.add(node.tagName.text);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const called = node.expression.text;
      if (enclosing === component) {
        if (HOOK_NAME.test(called)) {
          renderCalls.add(called);
          arity.set(called, Math.max(arity.get(called) ?? 0, node.arguments.length));
        }
      } else if (inHandler) {
        handlerCalls.add(called);
        // The WIDEST call the component makes is the ceiling on the generated
        // tool's input: a tool that accepts more than the host component ever
        // passed is a wider capability than the one being ported.
        arity.set(called, Math.max(arity.get(called) ?? 0, node.arguments.length));
      }
    }
    const inner = ts.isFunctionLike(node) ? node : enclosing;
    const handled = inHandler || handlers.has(node);
    ts.forEachChild(node, (child) => walk(child, inner, handled));
  };
  walk(sf, undefined, false);

  const read: PortBinding[] = [];
  const written: PortBinding[] = [];
  const holes: PortBinding[] = [];
  for (const [statement, bindings] of candidates) {
    const placed = bindings.map((binding) => ({
      binding,
      into: tags.has(binding.name) ? holes
        : renderCalls.has(binding.name) ? read
          : handlerCalls.has(binding.name) ? written : undefined,
    }));
    if (placed.some((entry) => entry.into === undefined)) continue;
    erase.add(statement);
    for (const { binding, into } of placed) {
      into?.push({ name: binding.name, imported: binding.imported, specifier: binding.specifier });
    }
  }

  let body = source;
  for (const statement of [...erase].sort((left, right) => right.getStart(sf) - left.getStart(sf))) {
    body = body.slice(0, statement.getStart(sf)) + body.slice(statement.end);
  }

  return {
    ...(read.length === 0 ? {} : {
      read: {
        tool: readToolName(slot),
        bindings: read.map((binding) => ({ ...binding, arity: arity.get(binding.name) ?? 0 })),
      },
    }),
    writes: written.map((binding) =>
      ({ tool: writeToolName(slot, binding.name), binding, arity: arity.get(binding.name) ?? 0 })),
    holes,
    body: body.trim(),
    trailer: defaultExportOf(source, file)?.name === slot ? "" : `export default ${slot};`,
  };
}

/**
 * The ported TSX, once the host's signatures are known.
 *
 * Separate from {@link portComponent} because a shim cannot be written before
 * its host function is resolved: it keeps the call site's arguments under the
 * host's OWN parameter names, so that the generated tool's input is the
 * original call's shape rather than an open bag.
 *
 * `parameters` maps a binding name to the parameter names its tool accepts, in
 * order — exactly as wide as the host component's own widest call.
 */
export function renderPort(
  port: Port,
  parameters: ReadonlyMap<string, readonly string[]>,
  /** Names the CARVER added to the screen surface: its holes, and the Kit
   *  Button when a host `<button>` was rewritten to it. */
  carved: readonly string[] = [],
): string {
  const imported = [
    ...(port.read === undefined ? [] : ["useQuery"]),
    ...(port.writes.length === 0 ? [] : ["tools"]),
    ...carved,
    ...port.holes.map((hole) => hole.name),
  ];
  const signature = (binding: string): string =>
    (parameters.get(binding) ?? []).map((name) => `${name}: any`).join(", ");
  const shims = [
    // The call site keeps its arguments so the host's line survives untouched.
    // A query's input is a literal resolved before the component renders, so
    // nothing here can FORWARD them — the wiring's tool declares the same names
    // instead, and the seed's live props answer them server-side.
    ...(port.read?.bindings ?? []).map((binding) =>
      `function ${binding.name}(${signature(binding.name)}) { return useQuery(${JSON.stringify(port.read!.tool)})?.${binding.name}; }`),
    ...port.writes.map(({ tool, binding }) => {
      const names = parameters.get(binding.name) ?? [];
      return `async function ${binding.name}(${signature(binding.name)}) { return tools.${tool}({ ${names.join(", ")} }); }`;
    }),
  ];
  const parts = [
    [
      imported.length === 0 ? "" : `import { ${imported.join(", ")} } from ${JSON.stringify(SCREEN_MODULE)};`,
      shims.join("\n"),
    ].filter((part) => part !== "").join("\n\n"),
    port.body,
    port.trailer,
  ].filter((part) => part !== "");
  return `${parts.join("\n\n")}\n`;
}
