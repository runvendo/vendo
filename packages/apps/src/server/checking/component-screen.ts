/**
 * The save-time gauntlet for a COMPONENT screen — the new artifact: one plain
 * `.tsx` file, one default-exported React component, data through
 * `useQuery("tool_name", {literal input}?)`, actions through
 * `tools.tool_name(args)` inside handlers, and nothing imported but `react` and
 * `@vendo/screen`.
 *
 * Five stages, and the order is not a preference: a file that does not compile
 * has no AST to scan; a scan that cannot name the queries has no plan to
 * type-check against; and a screen that does not type-check must never be
 * EXECUTED. So each stage is the next one's precondition and the first one that
 * finds something is the last one that runs.
 *
 *   1. COMPILE   esbuild, once per form (the CJS the engine evaluates, the
 *                module form the scan reads).
 *   2. SCAN      the two rules a compiler cannot state: the import surface is
 *                exactly two modules, and every query names a read tool with a
 *                literal name and a literal input. Plus the `tools` discipline —
 *                literal member access, called from a handler, never mid-render.
 *   3. TYPECHECK the real compiler, against declarations derived from the Kit's
 *                zod specs and the host tools' own schemas, with NO DOM lib —
 *                so `document`, `fetch` and `<div>` are errors because they
 *                genuinely do not exist here.
 *   4. RUN ONCE  execute the query plan for real, boot the screen on the answers,
 *                take its tree.
 *   5. TREE      the tree validators the wire artifact already ships.
 *
 * Every issue is written as a repair instruction. These messages are read by a
 * model, and a refusal that does not say what to write instead only costs a
 * round.
 *
 * The `.vendo` document checks (facts.ts) are untouched — this is the parallel
 * gauntlet for the new artifact, and it REUSES their machinery rather than
 * restating it: the same esbuild pattern, the same schema→TS printers
 * (screen-typings.ts), the same compiler harness (screen-tsc.ts), the same
 * `tools` literal-access scan (contract/island-ambient.ts), the same tree
 * validators (contract/genui/tree.ts + facts.ts), the same reviewer data
 * discipline (reviewer.ts).
 */
import { parse } from "acorn";
import type { Node, Program } from "acorn";
import { VENDO_TREE_FORMAT, type TreeNode } from "@vendoai/core";
import {
  DISPLAY_TAG_NAMES,
  resolveIslandToolName,
  scanIslandTools,
  validateTree,
  type NormalizedCatalog,
  type Tree,
  type VendoRouteMap,
} from "../../contract/index.js";
// The screen engine, by its own path: the contract door does not carry it yet.
import {
  SCREEN_TEXT_NODE,
  type FlatTree,
  type ScreenErrorKind,
} from "../../contract/genui/component/index.js";
import { isMutatingTool, type HostToolInfo } from "./deps.js";
import { catalogIssues, factIssueLine, kitNestingIssues, routeIssues } from "./facts.js";
import { sampleLines } from "./reviewer.js";
import { list, QUERY_HOOK } from "./screen-typecheck.js";
import {
  COMPONENT_SCREEN_LIB,
  componentScreenTypings,
  screenCatalogNames,
  SCREEN_MODULE,
  type ScreenCatalogEntry,
} from "./screen-typings.js";
import {
  defaultToolchain,
  ScreenToolchainUnavailable,
  type ScreenPaintResult,
  type ScreenToolchain,
  type ScreenTransform,
  type ScreenTypecheckResult,
} from "./toolchain.js";

// ---- the contract ---------------------------------------------------------


/** One thing wrong with the screen. `code` is the class, for a caller that
 *  routes; `message` is the repair instruction, for the model that reads it. */
export interface ComponentScreenIssue {
  code: string;
  message: string;
  /** …except this one is not about the screen at all: one of the three machines
   *  this gauntlet needs could not RUN here, so nothing was read and no rewrite
   *  can help. Set where the refusal is minted, because that is the only place
   *  that knows which happened, and carried out through the floor
   *  (`ComponentPaintResult.environment`) so a writing loop gives up instead of
   *  spending its budget repairing a screen nothing ever checked. */
  environment?: true;
}

/** One `useQuery` call, as the check will execute it. */
export interface QueryPlanEntry {
  tool: string;
  input?: unknown;
}

export type ComponentScreenCheck = {
  ok: boolean;
  issues: ComponentScreenIssue[];
  /** post-esbuild JS — what the engine evaluates. */
  compiled?: string;
  queryPlan?: QueryPlanEntry[];
  initialTree?: FlatTree;
  /** What each query REALLY returned, keyed by tool — the answers stage 4 booted
   *  the screen on. Handed back because the two things that need them cannot get
   *  them anywhere else: the paint carries them so the renderer boots the same
   *  screen this check rendered, and the AI reviewer judges the numbers on screen
   *  against them. Present on a passing check; a refusal earlier than stage 4 ran
   *  no queries at all. */
  queries?: Record<string, unknown>;
};

export interface ComponentScreenOptions {
  /** The TSX, verbatim. */
  source: string;
  /** The host tools a query or a handler may name. */
  hostTools: readonly HostToolInfo[];
  /** The components the screen may import from `@vendo/screen` — {@link screenCatalog}.
   *  A bare name is a component whose props nobody declared. */
  catalog: readonly ScreenCatalogEntry[];
  /** The pages a `<Link to>` may name. Absent → the host registered no registry
   *  and stage 5 measures no link against one. */
  routes?: VendoRouteMap;
  /** The trusted executor, injected by the caller: this check runs the screen's
   *  queries for real, and it is the caller who holds the guard-bound registry. */
  runQuery: (tool: string, input?: unknown) => Promise<unknown>;
  /** What compiles, type-checks and paints the screen — the one thing in this
   *  gauntlet that cannot run in every venue. Unset, this process's own
   *  ({@link defaultToolchain}); the floor names it one layer up. */
  toolchain?: ScreenToolchain;
}

const issue = (code: string, message: string): ComponentScreenIssue => ({ code, message });

/** A machine of this gauntlet that could not run — the compiler, the type
 *  checker or the engine. Three codes rather than one, because a caller that
 *  routes still needs to know WHICH; one mark, because what every reader of the
 *  sentence has to know is the same: this deployment cannot check screens, and
 *  the hand that fixes it is the one that built the server. */
const unavailable = (code: string, message: string): ComponentScreenIssue =>
  ({ code, message, environment: true });

const refuse = (
  issues: ComponentScreenIssue[],
  rest: Omit<ComponentScreenCheck, "ok" | "issues"> = {},
): ComponentScreenCheck => ({ ok: false, issues, ...rest });

// ---- stage 1: compile -----------------------------------------------------

/** esbuild reports a location; a screen author's repair starts from the line. */
const compileMessage = (error: unknown): string => {
  const first = (error as { errors?: Array<{ text?: string; location?: { line?: number } | null }> }).errors?.[0];
  const detail = first?.text ?? (error instanceof Error ? error.message : String(error));
  const line = first?.location?.line;
  return `does not compile as TSX${line === undefined ? "" : ` (line ${line})`}: ${detail}`
    + " — a screen is one plain .tsx module: its imports, then one default-exported React component.";
};

// ---- the AST walk ---------------------------------------------------------

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/** The child nodes of an ESTree node, whatever its type. Generic on purpose — a
 *  hand-written case per node type is a list that silently rots as the grammar
 *  edition moves (the same reason genui/expr.ts walks this way). */
const childNodes = (node: Node): Node[] => {
  const children: Node[] = [];
  for (const value of Object.values(node as unknown as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) children.push(item);
    } else if (isNode(value)) children.push(value);
  }
  return children;
};

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/**
 * What owns the code inside it, for the render-time question alone: every
 * function, plus an INSTANCE field initializer.
 *
 * The distinction is when the body runs. An instance field runs on `new`, so
 * its calls belong to whoever constructs the class — attributing them to the
 * render that merely encloses the class declaration refuses a screen whose
 * author did precisely what the refusal asks for. A STATIC field runs when the
 * class definition itself is evaluated, which IS the render, so it stays
 * attributed to the render and keeps earning `tool-at-render`.
 *
 * Kept apart from FUNCTION_TYPES on purpose: that set answers a different
 * question — "could this node BE the component" — and must stay functions only.
 */
const ownsItsScope = (node: Node): boolean =>
  FUNCTION_TYPES.has(node.type)
  || (node.type === "PropertyDefinition" && (node as unknown as { static?: boolean }).static !== true);

/** A class `static {}` block anywhere in the module — an AST question, because
 *  `static {` is also ordinary prose: it turns up in strings, in comments and in
 *  JSX text, and a screen that merely SAYS it is not a screen that DOES it. The
 *  scan form is compiled to es2022 precisely so the block survives as a node to
 *  find; at es2020 esbuild lowers it away and there is nothing left to ask. */
const hasStaticBlock = (node: Node): boolean =>
  node.type === "StaticBlock" || childNodes(node).some(hasStaticBlock);

interface CallNode extends Node {
  callee: Node;
  arguments: Node[];
}

const asCall = (node: Node): CallNode | undefined =>
  node.type === "CallExpression" ? (node as unknown as CallNode) : undefined;

const identifierName = (node: Node | undefined): string | undefined =>
  node?.type === "Identifier" ? (node as unknown as { name: string }).name : undefined;

/** `tools.tool_name` as a called member chain — the only form that reaches a
 *  tool. The chain's names, or undefined when the callee is not one. */
const toolChain = (callee: Node): string[] | undefined => {
  const names: string[] = [];
  let current = callee;
  while (current.type === "MemberExpression") {
    const member = current as unknown as { object: Node; property: Node; computed: boolean };
    if (member.computed) return undefined;
    const name = identifierName(member.property);
    if (name === undefined) return undefined;
    names.unshift(name);
    current = member.object;
  }
  return identifierName(current) === "tools" && names.length > 0 ? names : undefined;
};

/** The value of a literal-JSON expression: `{ ok: true, value }`, or `ok: false`
 *  for anything computed. A query input executes as literal JSON, so this is the
 *  whole vocabulary an input may be written in. */
const literalValue = (node: Node): { ok: true; value: unknown } | { ok: false } => {
  if (node.type === "Literal") {
    const { value } = node as unknown as { value: unknown };
    return typeof value === "object" && value !== null ? { ok: false } : { ok: true, value };
  }
  if (node.type === "UnaryExpression") {
    const unary = node as unknown as { operator: string; argument: Node };
    const inner = unary.operator === "-" ? literalValue(unary.argument) : { ok: false as const };
    return inner.ok && typeof inner.value === "number" ? { ok: true, value: -inner.value } : { ok: false };
  }
  if (node.type === "ArrayExpression") {
    const items: unknown[] = [];
    for (const element of (node as unknown as { elements: Array<Node | null> }).elements) {
      if (element === null) return { ok: false };
      const item = literalValue(element);
      if (!item.ok) return { ok: false };
      items.push(item.value);
    }
    return { ok: true, value: items };
  }
  if (node.type === "ObjectExpression") {
    const value: Record<string, unknown> = {};
    for (const property of (node as unknown as { properties: Node[] }).properties) {
      if (property.type !== "Property") return { ok: false };
      const entry = property as unknown as { key: Node; value: Node; computed: boolean; kind: string };
      if (entry.computed || entry.kind !== "init") return { ok: false };
      const key = identifierName(entry.key)
        ?? (entry.key.type === "Literal" ? String((entry.key as unknown as { value: unknown }).value) : undefined);
      if (key === undefined) return { ok: false };
      const item = literalValue(entry.value);
      if (!item.ok) return { ok: false };
      value[key] = item.value;
    }
    return { ok: true, value };
  }
  return { ok: false };
};

// ---- stage 2: scan --------------------------------------------------------

const ALLOWED_IMPORTS: readonly string[] = ["react", SCREEN_MODULE];

/**
 * A `namespace` block, off the AUTHOR's source — the module form cannot answer
 * this. esbuild lowers a namespace to an IIFE and a types-only transform has no
 * output form for one at all, so by the time there is a parsed module the
 * construct is gone either way.
 *
 * Text matching is therefore the only reading available, and it is written to
 * fail CLOSED: `\s` on both sides so a brace on the next line still counts, and
 * a non-identifier lookbehind rather than a line anchor so `const x = 1;
 * namespace Foo {` is seen — those were misses, and a guard that misses admits
 * the very screen it exists to catch.
 *
 * The residual runs the other way, and it is the WHOLE of the author's file:
 * this reads raw text, so the words `namespace X {` are refused wherever they
 * appear — in a line comment, in a block comment, in a string, in a template
 * literal, in JSX text. Nothing here strips any of those, and a screen that
 * merely SAYS the construct is refused as if it declared one. That is the
 * accepted price: unlike the `static {}` guard, no AST can answer this, because
 * every toolchain erases the construct before there is a tree to read. A false
 * refusal costs one repair round on a screen nobody writes; a miss ships a
 * screen that paints differently in two venues. `scan-fidelity.test.ts` pins
 * this behaviour deliberately, so that closing it cannot silently reopen the
 * `namespace Foo\n{` miss.
 *
 * One residual runs the OTHER way and is accepted on the same terms: `\s` does
 * not match a comment, so a REAL declaration with a block comment between the
 * keyword, the name or the brace is admitted — those shapes pass the whole
 * gauntlet, which is a miss and not a false refusal. The
 * only fix is lexing the file to read through comments, and this guard exists
 * precisely because there is no parse of the construct to lean on. Pinned in the
 * same place as the false positives, so the accepted set is honest in both
 * directions.
 */
const NAMESPACE_BLOCK = /(?<![\w$])namespace\s+([A-Za-z_$][\w$.]*)\s*\{/u;

/** The import block is not `tools` USAGE: `import { tools } from "@vendo/screen"`
 *  puts the name in expression position (a `{` to its left), which the shipped
 *  literal-access scan reads as aliasing. Blanked with offsets preserved, so that
 *  scan's own positions still line up. */
const blankImports = (source: string, program: Program): string => {
  const characters = source.split("");
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (let index = statement.start; index < statement.end; index += 1) characters[index] = " ";
  }
  return characters.join("");
};

/** The default-exported component, when the module's default export is a
 *  function — directly, or through the name of a function declared in the file.
 *  `node: undefined` with `declared: true` is "there is a default, and it is not
 *  a component", which the export check reports separately. */
const defaultComponent = (program: Program): { node?: Node; declared: boolean } => {
  let declaration: Node | undefined;
  let name: string | undefined;
  for (const statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      declaration = (statement as unknown as { declaration: Node }).declaration;
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration") continue;
    // esbuild's module output rewrites `export default function Screen` into a
    // declaration plus `export { Screen as default }`, so the default arrives
    // here by name rather than inline.
    for (const specifier of (statement as unknown as { specifiers?: Node[] }).specifiers ?? []) {
      const entry = specifier as unknown as { local: Node; exported: Node };
      const exported = identifierName(entry.exported)
        ?? (entry.exported.type === "Literal" ? String((entry.exported as unknown as { value: unknown }).value) : undefined);
      if (exported === "default") name = identifierName(entry.local);
    }
  }
  if (declaration !== undefined) {
    if (FUNCTION_TYPES.has(declaration.type)) return { node: declaration, declared: true };
    name = identifierName(declaration);
    if (name === undefined) return { declared: true };
  } else if (name === undefined) {
    return { declared: false };
  }
  /** Every top-level binding that could BE the component: a function
   *  declaration, or a variable's initializer. */
  const bound = new Map<string, Node>();
  for (const statement of program.body) {
    if (statement.type === "FunctionDeclaration") {
      const id = identifierName((statement as unknown as { id?: Node }).id);
      if (id !== undefined) bound.set(id, statement);
    }
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of (statement as unknown as { declarations: Node[] }).declarations) {
      const entry = declarator as unknown as { id: Node; init?: Node | null };
      const id = identifierName(entry.id);
      if (id !== undefined && entry.init != null) bound.set(id, entry.init);
    }
  }
  // One name reaches the component through another, and esbuild writes that hop
  // itself: `const Screen = () => …; export default Screen;` compiles to
  // `var stdin_default = Screen; export { stdin_default as default }`, so a walk
  // that stops at the first binding refuses the form the manual's own examples
  // are written in. `seen` is what makes `let a = b, b = a` terminate.
  const seen = new Set<string>();
  let at: string | undefined = name;
  while (at !== undefined && !seen.has(at)) {
    seen.add(at);
    const target = bound.get(at);
    if (target !== undefined && FUNCTION_TYPES.has(target.type)) return { node: target, declared: true };
    at = identifierName(target);
  }
  return { declared: true };
};

interface ScanResult {
  issues: ComponentScreenIssue[];
  queryPlan: QueryPlanEntry[];
}

const scan = (moduleSource: string, source: string, tools: readonly HostToolInfo[]): ScanResult => {
  const issues: ComponentScreenIssue[] = [];
  const queryPlan: QueryPlanEntry[] = [];
  let program: Program;
  try {
    // The input is esbuild's own ES2022 output, and the edition is pinned to
    // match rather than "latest": the grammar a screen is admitted under must
    // not move when the parser is upgraded (genui/expr.ts pins it for the same
    // reason). 2022 is also the edition that HAS `StaticBlock` — pinned lower,
    // the parser would reject the block outright and the guard below could
    // never name it.
    program = parse(moduleSource, { ecmaVersion: 2022, sourceType: "module" });
  } catch (error) {
    return { issues: [issue("compile", `does not parse as a module: ${error instanceof Error ? error.message : String(error)}`)], queryPlan };
  }

  const known = tools.map((tool) => tool.name);
  const readable = tools.filter((tool) => !isMutatingTool(tool)).map((tool) => tool.name);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  // (a) the two constructs whose compiled form depends on which toolchain ran.
  const namespaced = NAMESPACE_BLOCK.exec(source);
  if (namespaced !== null) {
    issues.push(issue("namespace", `declares a namespace block (namespace ${namespaced[1]} { … }) — a screen is compiled by a types-only transform, which has no output form for one, so this file would compile in one venue and not in another. A screen is ONE file and needs no inner scope: write plain top-level consts, functions and types instead.`));
  }
  if (hasStaticBlock(program)) {
    issues.push(issue("static-block", `writes a class static initializer block (static { … }) — a screen is compiled by a types-only transform, which emits the class as written, so this block reaches the screen VM unlowered and the same file does not run the same in every venue. Do that work in the component body, or in a plain top-level const.`));
  }

  // (b) the import surface. An UNUSED disallowed import is elided by the
  // transform before it reaches here — and it cannot affect the screen either,
  // since nothing requires it; the type check still sees it in the source.
  for (const statement of program.body) {
    const source = (statement as unknown as { source?: { value?: unknown } }).source;
    if (typeof source?.value !== "string") continue;
    if (ALLOWED_IMPORTS.includes(source.value)) continue;
    issues.push(issue("import", `imports ${JSON.stringify(source.value)} — a screen may import only "react" (its hooks) and ${JSON.stringify(SCREEN_MODULE)} (the components, ${QUERY_HOOK} and tools). There is no bundler and no node_modules here: read data with ${QUERY_HOOK}("tool_name") and act with tools.tool_name(args) instead of reaching for a package.`));
  }

  const component = defaultComponent(program);

  const visit = (node: Node, nearestFunction: Node | undefined): void => {
    if (node.type === "ImportExpression") {
      issues.push(issue("import", `loads a module at runtime with import(…) — a screen's imports are static and limited to "react" and ${JSON.stringify(SCREEN_MODULE)}; there is nothing to load here at runtime.`));
    }
    const call = asCall(node);
    if (call !== undefined) {
      if (identifierName(call.callee) === "require") {
        issues.push(issue("import", `calls require(…) — a screen imports statically, and only from "react" and ${JSON.stringify(SCREEN_MODULE)}.`));
      }
      if (identifierName(call.callee) === QUERY_HOOK) {
        scanQuery(call, { issues, queryPlan, readable, known, byName });
      }
      const chain = toolChain(call.callee);
      if (chain !== undefined) {
        const name = resolveIslandToolName(chain, new Set(known));
        if (name === null) {
          issues.push(issue("tool-name", `tools.${chain.join(".")}(…) names unknown tool "${chain.join("_")}"; the host tools are: ${list(known)}`));
        } else if (nearestFunction === undefined || nearestFunction === component.node) {
          // The defect this catches is not style: a tool called from the render
          // body runs on EVERY render, so a write fires with nobody clicking.
          issues.push(issue("tool-at-render", `calls tools.${chain.join(".")}(…) while the component is rendering — a tool call in the component body runs on every render, so a write fires with nobody clicking. Put it in a handler (onClick={() => tools.${name}({ … })}), and read the data the render needs with ${QUERY_HOOK}("tool_name").`));
        }
      }
    }
    const inner = ownsItsScope(node) ? node : nearestFunction;
    for (const child of childNodes(node)) visit(child, inner);
  };
  visit(program, undefined);

  // The shipped literal-access scan, verbatim: computed access and aliasing are
  // violations, and its sentences already teach the repair.
  for (const violation of scanIslandTools(blankImports(moduleSource, program)).violations) {
    issues.push(issue("tool-access", violation));
  }

  if (!component.declared) {
    issues.push(issue("default-export", `exports no default — a screen is one file that default-exports its component: export default function Screen() { … }.`));
  } else if (component.node === undefined) {
    issues.push(issue("default-export", `default-exports something that is not a component — a screen default-exports one React function component: export default function Screen() { … }.`));
  }

  return { issues, queryPlan };
};

const scanQuery = (
  call: CallNode,
  context: {
    issues: ComponentScreenIssue[];
    queryPlan: QueryPlanEntry[];
    readable: readonly string[];
    known: readonly string[];
    byName: ReadonlyMap<string, HostToolInfo>;
  },
): void => {
  const [name, input, ...extra] = call.arguments;
  const literal = name?.type === "Literal" ? (name as unknown as { value: unknown }).value : undefined;
  if (typeof literal !== "string") {
    context.issues.push(issue("query-name", `calls ${QUERY_HOOK}(…) with a computed tool name — the first argument must be a written-out string literal, because a screen's queries are read out of the file and executed BEFORE the component ever renders. Write ${QUERY_HOOK}("tool_name"). The tools you can read are: ${list(context.readable)}.`));
    return;
  }
  const tool = context.byName.get(literal);
  if (tool === undefined) {
    // The no-readable-tool case has to be said outright. A model refused with a
    // list it cannot use invents a near-miss name, and after enough refusals it
    // ships a screen that ASSERTS the data is missing above data it made up.
    context.issues.push(issue("query-tool", context.readable.length === 0
      ? `${QUERY_HOOK}("${literal}") names unknown tool "${literal}", and this product has NO tool a screen can read. There is no data behind this ask. Do not invent a tool name, and do not claim the data is missing or empty, which you cannot know: drop the query and use <Disclaimer> to say plainly that no tool provides this data.`
      : `${QUERY_HOOK}("${literal}") names unknown tool "${literal}"; the host tools are: ${list(context.known)}`));
    return;
  }
  if (isMutatingTool(tool)) {
    context.issues.push(issue("query-tool", `${QUERY_HOOK}("${literal}") reads with a tool that CHANGES things (risk "${tool.risk}") — a query runs on every render, so this would write every time the screen paints. Call it from a handler as tools.${literal}({ … }), and read with one of: ${list(context.readable)}.`));
    return;
  }
  if (extra.length > 0) {
    context.issues.push(issue("query-input", `calls ${QUERY_HOOK}("${literal}", …) with ${call.arguments.length} arguments — it takes the tool name and, at most, one literal input object.`));
    return;
  }
  let value: unknown;
  if (input !== undefined) {
    const parsed = literalValue(input);
    if (!parsed.ok) {
      context.issues.push(issue("query-input", `passes a computed input to ${QUERY_HOOK}("${literal}", …) — a query input must be LITERAL JSON the tool can execute directly: the queries run before the component renders, so no prop, state, hook value or other query's result can reach one. Write the literal (${QUERY_HOOK}("${literal}", { status: "pending" })), and derive what you needed from the result where you DISPLAY it.`));
      return;
    }
    value = parsed.value;
  }
  const entry: QueryPlanEntry = input === undefined ? { tool: literal } : { tool: literal, input: value };
  const already = context.queryPlan.find((planned) => planned.tool === entry.tool);
  if (already === undefined) {
    context.queryPlan.push(entry);
    return;
  }
  // The engine resolves a screen's data as one result PER TOOL, so two reads of
  // the same tool with different inputs cannot both be served — the second would
  // silently paint the first one's rows.
  if (JSON.stringify(already.input) !== JSON.stringify(entry.input)) {
    context.issues.push(issue("query-input", `reads "${literal}" twice with DIFFERENT inputs — a screen resolves one result per tool, so both calls would receive the same rows. Read it once with the wider input and narrow it where you display it (rows.filter(…)), or read a tool that takes the narrower ask.`));
  }
};

// ---- stage 3: typecheck ---------------------------------------------------


/** Already-announced holes. A construct the printers cannot model degrades to
 *  `any`, which is the right call — a prop typed by guess would reject working
 *  code — but it means the gate stopped checking that prop, and a silent hole is
 *  how a check rots. Announced ONCE per distinct construct per process: a line on
 *  every screen is a line nobody reads. */
const announced = new Set<string>();

const announceUntyped = (notes: readonly string[]): void => {
  const fresh = [...new Set(notes)].filter((note) => !announced.has(note));
  if (fresh.length === 0) return;
  for (const note of fresh) announced.add(note);
  console.warn(`[vendo] component screen type check: ${fresh.length} schema construct(s) could not be typed, so they are UNCHECKED — ${fresh.join("; ")}`);
};

// ---- stage 4: run once ----------------------------------------------------

/** What went wrong inside the VM, said as a repair. A `render` or `budget`
 *  failure is RELAYED: the engine writes those messages to be read by whatever
 *  repairs the screen, and a second sentence of advice on top of them only says
 *  the same thing twice. A throw is the class that needs the advice. */
const renderMessage = (kind: ScreenErrorKind, thrown: string): string => {
  const message = thrown.split("\n")[0] ?? "";
  if (kind === "render" || kind === "budget") {
    return `the screen would not paint: ${message}`;
  }
  return `the screen threw while rendering against the data its queries really returned: ${message}`
    + " — the component must render for every answer a tool can give: guard an undefined or empty result before .map/.reduce and render an empty state instead.";
};

// ---- the gauntlet ---------------------------------------------------------

/**
 * Run every stage over one screen. Fail-fast: the returned `issues` are the
 * first stage's that found any, so a repair round is never handed a list of
 * consequences of a break it has not fixed yet.
 */
export async function checkComponentScreen(opts: ComponentScreenOptions): Promise<ComponentScreenCheck> {
  const toolchain = opts.toolchain ?? defaultToolchain();

  let forms: ScreenTransform;
  try {
    forms = await toolchain.transform(opts.source);
  } catch (error) {
    // A toolchain that cannot compile is a FAILED check, not a skipped one:
    // nothing downstream can run without the compiled screen, and a gate that
    // read nothing must not answer "fine".
    return refuse([error instanceof ScreenToolchainUnavailable
      ? unavailable("toolchain-unavailable", `the screen could not be compiled: ${error.message}, so nothing about this screen was checked. This check refuses to pass a screen it never read.`)
      : issue("compile", compileMessage(error))]);
  }
  const compiled = forms.engine;

  const scanned = scan(forms.scan, opts.source, opts.hostTools);
  if (scanned.issues.length > 0) return refuse(scanned.issues, { compiled });
  const queryPlan = scanned.queryPlan;

  /** The declared surface as NAMES — what the engine boots with and what the tree
   *  check measures against. The props a catalog entry carries are the type
   *  check's business alone; every other stage takes the same list it always did. */
  const names = screenCatalogNames(opts.catalog);

  const notes: string[] = [];
  const typings = componentScreenTypings({
    catalog: opts.catalog,
    tools: opts.hostTools,
    note: (reason) => notes.push(reason),
  });
  announceUntyped(notes);

  let typed: ScreenTypecheckResult;
  try {
    typed = await toolchain.typecheck({
      source: opts.source,
      typings,
      lib: COMPONENT_SCREEN_LIB,
      components: names,
    });
  } catch (error) {
    // A toolchain reached over a service binding reports failure by THROWING —
    // only an in-process one can answer `{ ok: false }`. Both are the same
    // unavailable, and an RPC that broke is a refusal, never a silent pass.
    typed = { ok: false, why: error instanceof Error ? error.message : String(error) };
  }
  if (!typed.ok) {
    return refuse([unavailable("typecheck-unavailable", `the screen could not be type-checked: ${typed.why}. This check refuses to pass a screen it never read — make the TypeScript compiler reachable where the build runs.`)], { compiled, queryPlan });
  }
  if (typed.issues.length > 0) return refuse([...typed.issues], { compiled, queryPlan });

  // The engine keys its results by TOOL, one entry each — which is why the scan
  // refuses a screen that reads one tool with two different inputs.
  const queries: Record<string, unknown> = {};
  for (const entry of queryPlan) {
    try {
      queries[entry.tool] = await opts.runQuery(entry.tool, entry.input);
    } catch (error) {
      return refuse([issue("run", `the query ${QUERY_HOOK}("${entry.tool}"${entry.input === undefined ? "" : `, ${JSON.stringify(entry.input)}`}) failed when this check ran it: ${error instanceof Error ? error.message : String(error)} — a screen may only read a tool that answers; check the input against the tool's own schema.`)], { compiled, queryPlan });
    }
  }

  let painted: ScreenPaintResult;
  try {
    // A clock IS given: the surface renders with one, and a gate that is
    // stricter than production blocks screens that work.
    painted = await toolchain.paint({ compiledSource: compiled, queries, catalog: names, now: Date.now() });
  } catch (error) {
    // A paint answers a screen that failed with a verdict, so a THROW is the
    // engine itself never starting — this deployment's third machine missing,
    // not a screen to repair. Its own code for the same reason: `run` is the
    // class for a screen that RAN, and these two must never read alike.
    return refuse([unavailable("engine-unavailable", `the screen was never executed: the screen engine would not start (${error instanceof Error ? error.message : String(error)}). This check refuses to pass a screen it could not render.`)], { compiled, queryPlan });
  }
  if (!painted.ok) {
    return refuse([issue("run", renderMessage(painted.kind, painted.message))], { compiled, queryPlan });
  }

  const initialTree = painted.tree;
  const treeIssues = await treeCheckIssues(initialTree, names, opts.routes);
  if (treeIssues.length > 0) return refuse(treeIssues, { compiled, queryPlan, initialTree });

  return { ok: true, issues: [], compiled, queryPlan, initialTree, queries };
}

/**
 * The name a screen gives itself: its default-exported component's, split on camel
 * case (`PendingTransfers` → "Pending transfers").
 *
 * A component file has no `<App name="…">` to read — the function's name is the
 * only title in it — and this name is what the person's app list shows, so an
 * anonymous default export gets "Screen" rather than a blank row. Presentation
 * only: nothing decides anything on it.
 *
 * Read with a regex rather than off the scan's AST because both callers ask BEFORE
 * a parse is guaranteed (the receipt's title on any save that landed, the app row's
 * name on the save that painted), and a title is never a reason to fail.
 */
export function screenName(source: string): string {
  const declared = /export\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/u.exec(source)
    // `const Screen = () => …; export default Screen;` — the other form the
    // manual's own examples would compile to.
    ?? /export\s+default\s+([A-Za-z_$][\w$]*)\s*;/u.exec(source);
  const name = declared?.[1];
  if (name === undefined) return "Screen";
  const [first, ...rest] = name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").split(/\s+/u);
  return [first, ...rest.map((word) => word.toLowerCase())].join(" ");
}

// ---- stage 5: the tree ----------------------------------------------------

/** The wire artifact's own validators over the rendered tree. Not a second
 *  implementation: `validateTree` is the format gate and `catalogIssues` is the
 *  `components-exist` fact check, both used as they ship. The catalog arrives
 *  here as names only, so a host component contributes its NAME to the
 *  vocabulary and nothing else — its props were the type check's business.
 *
 *  A text run is the engine's own node kind, not a component anybody registered,
 *  so it is not measured against the catalog — but it IS a child, so the nesting
 *  rule reads the tree whole: text nested in a component that renders no
 *  children is the same blank as a node nested there. A display brick is the
 *  same case: the renderer resolves it beside the Kit, nothing registered it,
 *  and the type check already refused every tag that is not one. */
const DISPLAY_TAGS: ReadonlySet<string> = new Set(DISPLAY_TAG_NAMES);

const treeCheckIssues = async (
  flat: FlatTree,
  catalog: readonly string[],
  routes: VendoRouteMap | undefined,
): Promise<ComponentScreenIssue[]> => {
  const nodes = Object.values(flat.nodes) as TreeNode[];
  const tree: Tree = { formatVersion: VENDO_TREE_FORMAT, root: flat.root, nodes };
  const validation = validateTree(tree);
  if (!validation.ok) {
    return [issue("tree", `the rendered screen is not a valid tree: ${validation.error.message}`)];
  }
  const normalized: NormalizedCatalog = [...new Set(catalog)].map((name) => ({ name, description: "" }));
  const found = await catalogIssues(
    { ...validation.tree, nodes: nodes.filter((node) => node.component !== SCREEN_TEXT_NODE && !DISPLAY_TAGS.has(node.component)) },
    undefined,
    normalized,
  );
  return [
    ...kitNestingIssues(validation.tree).map((entry) => issue("nesting", factIssueLine(entry))),
    ...routeIssues(validation.tree, routes).map((entry) => issue("routes", factIssueLine(entry))),
    ...found.map((entry) => issue("tree", factIssueLine(entry))),
  ];
};

// ---- the reviewer's input -------------------------------------------------

/**
 * What the AI reviewer reads: the TSX itself, plus what each query really
 * returned, truncated by the same rule the wire reviewer uses (reviewer.ts) so
 * one long table cannot crowd the screen out of the prompt.
 *
 * The TSX comes FIRST and whole: it is the thing being judged, and unlike the
 * wire artifact there is nothing to print — the file the model wrote is the file
 * the reviewer reads.
 */
export function reviewComponentScreenInput(input: {
  source: string;
  queryResults: Readonly<Record<string, unknown>>;
}): string {
  return `SCREEN (the .tsx file this app renders):\n${input.source}${sampleLines(input.queryResults)}`;
}
