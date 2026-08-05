/**
 * `tsc` as the checks floor's static half.
 *
 * Given a screen file's text and the declarations {@link screenTypings}
 * derived from the catalog / Kit specs / tool shapes, this runs the real
 * TypeScript compiler over the pair in memory and translates its diagnostics
 * into the floor's findings. The compiler is the check: component names, prop
 * names, prop types, dotted data access and aggregate field names are all one
 * question — does this file type-check against the surface it is allowed to
 * name — and a compiler answers it better than a hand-rolled walker.
 *
 * DEGRADATION IS THE LAW. The compiler is resolved lazily through this
 * package's own dependency graph and feature-gated; when it cannot be loaded,
 * or loads but predates the API this module calls, the check returns NO
 * findings and never fails a build — the same posture as the smoke-render gate
 * ("Environment failures … skip the gate silently — the esbuild lazy-load
 * precedent", generation/validation/smoke-render.ts:26-30) and as extraction's
 * "extraction never fails your build" floor (actions/sync/compiler-gate.ts).
 *
 * The lazy `createRequire` resolution is not a style choice: `typescript@` is
 * on the portability gate's FORBIDDEN_INPUTS (scripts/portability-gate.mjs),
 * and `@vendoai/apps` is reachable from the Worker server entry, so a static
 * `import ... from "typescript"` here would break `pnpm lint`. Layering
 * (apps → core only) is why this is not the loader in
 * `packages/actions/src/sync/common.ts:178-190`; that loader is the pattern
 * this one copies.
 *
 * Messages are written from the AST, not scraped from the compiler's prose: a
 * raw `TS2322` dump naming two anonymous object types is unactionable, where
 * "sets unknown prop \"data\" on <Table>; the renderer drops it. Allowed props:
 * columns, rows, …" is the same sentence the bespoke checks already speak.
 */
import { createRequire } from "node:module";
import type TS from "typescript";
import { SCREEN_TYPINGS_FILE } from "./screen-typings.js";
import type { Finding } from "./types.js";

/** The screen file's virtual path. Its text is used VERBATIM, so a finding's
 *  line numbers are the author's line numbers. */
const SCREEN_FILE = "/screen.tsx";

/** Every module-level compiler function this module calls, feature-detected
 *  one by one rather than by version string — the shape of the gate in
 *  `packages/actions/src/sync/compiler-gate.ts`, kept local because apps may
 *  not depend on actions. A compiler missing any of them degrades exactly like
 *  a compiler that failed to load. */
const REQUIRED_COMPILER_API = [
  "createProgram", "createSourceFile", "flattenDiagnosticMessageText", "forEachChild",
  "getDefaultLibFilePath", "isCallExpression", "isIdentifier", "isJsxAttribute",
  "isJsxAttributes", "isJsxExpression", "isJsxOpeningElement", "isJsxSelfClosingElement",
  "isPropertyAccessExpression",
] as const;

let compilerModule: typeof TS | null | undefined;

const usable = (candidate: unknown): boolean => {
  const ts = candidate as Record<string, unknown> | null | undefined;
  return ts !== null && ts !== undefined
    && REQUIRED_COMPILER_API.every((api) => typeof ts[api] === "function")
    && typeof (ts as { sys?: { readFile?: unknown } }).sys?.readFile === "function";
};

const loadCompiler = (): typeof TS | null => {
  if (compilerModule === undefined) {
    try {
      const candidate = createRequire(import.meta.url)("typescript") as typeof TS;
      compilerModule = usable(candidate) ? candidate : null;
    } catch {
      compilerModule = null;
    }
  }
  return compilerModule;
};

/** Test seam: the resolution is memoized for the process (a host's toolchain
 *  does not change mid-run), so the silent-degradation paths are unreachable
 *  from a test without one. Returns the restore. */
export function __setCompilerForTests(candidate: typeof TS | null): () => void {
  const previous = compilerModule;
  compilerModule = candidate === null ? null : (usable(candidate) ? candidate : null);
  return () => { compilerModule = previous; };
}

export interface ScreenTscInput {
  /** The screen file's text, verbatim. */
  readonly screen: string;
  /** The ambient declarations from {@link screenTypings}. */
  readonly typings: string;
}

/** Parsed lib files, keyed by path. A program costs ~450ms cold and ~5ms warm,
 *  and the lib files are immutable for the process. */
const libCache = new Map<string, TS.SourceFile>();

const compilerOptions = (ts: typeof TS): TS.CompilerOptions => ({
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ES2020,
  // The smallest lib carrying Array/ReadonlyArray/Record — a screen is
  // declarative, so nothing here needs a newer standard library.
  lib: ["lib.es5.d.ts"],
  module: ts.ModuleKind.ESNext,
  types: [],
  noEmit: true,
  // Deliberately loose: this check reports what the SURFACE says, not house
  // style. noImplicitAny/strictNullChecks findings would be noise a screen
  // author cannot act on.
  strict: false,
  noResolve: true,
  skipLibCheck: true,
  skipDefaultLibCheck: true,
});

const buildProgram = (ts: typeof TS, input: ScreenTscInput): TS.Program => {
  const options = compilerOptions(ts);
  const files = new Map([[SCREEN_FILE, input.screen], [SCREEN_TYPINGS_FILE, input.typings]]);
  const create = (name: string, text: string, version: TS.ScriptTarget | TS.CreateSourceFileOptions): TS.SourceFile =>
    ts.createSourceFile(name, text, version, true, name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const host: TS.CompilerHost = {
    getSourceFile: (name, version) => {
      const own = files.get(name);
      if (own !== undefined) return create(name, own, version);
      const cached = libCache.get(name);
      if (cached !== undefined) return cached;
      const text = ts.sys.readFile(name);
      if (text === undefined) return undefined;
      const file = create(name, text, version);
      libCache.set(name, file);
      return file;
    },
    getDefaultLibFileName: (compilerOptionsIn) => ts.getDefaultLibFilePath(compilerOptionsIn),
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => files.has(name) || ts.sys.fileExists(name),
    readFile: (name) => files.get(name) ?? ts.sys.readFile(name),
  };
  return ts.createProgram({ rootNames: [SCREEN_FILE, SCREEN_TYPINGS_FILE], options, host });
};

// ---- locating a diagnostic ------------------------------------------------

interface Locus {
  node: TS.Node;
  /** The enclosing JSX element's tag text, when there is one. */
  component?: string;
  /** The enclosing JSX attribute's name, when there is one. */
  prop?: string;
  element?: TS.JsxOpeningElement | TS.JsxSelfClosingElement;
}

const deepestNodeAt = (ts: typeof TS, file: TS.SourceFile, start: number, end: number): TS.Node => {
  let best: TS.Node = file;
  const visit = (node: TS.Node): void => {
    if (node.getStart(file) > start || end > node.getEnd()) return;
    best = node;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return best;
};

const locusOf = (ts: typeof TS, file: TS.SourceFile, diagnostic: TS.Diagnostic): Locus => {
  const start = diagnostic.start ?? 0;
  const node = deepestNodeAt(ts, file, start, start + (diagnostic.length ?? 0));
  const locus: Locus = { node };
  for (let current: TS.Node | undefined = node; current !== undefined; current = current.parent) {
    if (locus.prop === undefined && ts.isJsxAttribute(current)) locus.prop = current.name.getText(file);
    if (locus.element === undefined && (ts.isJsxOpeningElement(current) || ts.isJsxSelfClosingElement(current))) {
      locus.element = current;
      locus.component = current.tagName.getText(file);
    }
  }
  return locus;
};

const whereOf = (file: TS.SourceFile, diagnostic: TS.Diagnostic, locus: Locus): string => {
  if (locus.component !== undefined) {
    return locus.prop === undefined ? `<${locus.component}>` : `<${locus.component}> prop "${locus.prop}"`;
  }
  return `line ${file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1}`;
};

// ---- translating a diagnostic --------------------------------------------

/** A prop-type name short enough to read. A screen's row types print as long
 *  anonymous objects; the author needs the SHAPE class, not every field. */
const briefType = (ts: typeof TS, checker: TS.TypeChecker, type: TS.Type | undefined): string => {
  if (type === undefined) return "a different type";
  const text = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
  if (text.length <= 60) return text;
  if (text.endsWith("[]") || text.startsWith("Array<")) return "a list of rows";
  return text.slice(0, 57).concat("…");
};

const propsOf = (ts: typeof TS, checker: TS.TypeChecker, element: TS.JsxOpeningElement | TS.JsxSelfClosingElement): {
  all: string[];
  required: string[];
} | undefined => {
  const signature = checker.getTypeAtLocation(element.tagName).getCallSignatures()[0];
  const parameter = signature?.getParameters()[0];
  if (parameter === undefined) return undefined;
  const type = checker.getTypeOfSymbolAtLocation(parameter, element.tagName);
  const symbols = checker.getPropertiesOfType(type)
    // `children` and `pending` are the renderer's own, taught to every
    // component by the generator; listing them would teach the model to write
    // them as props.
    .filter((symbol) => symbol.getName() !== "children" && symbol.getName() !== "pending");
  return {
    all: symbols.map((symbol) => symbol.getName()),
    required: symbols.filter((symbol) => (symbol.flags & ts.SymbolFlags.Optional) === 0).map((symbol) => symbol.getName()),
  };
};

const writtenProps = (ts: typeof TS, file: TS.SourceFile, element: TS.JsxOpeningElement | TS.JsxSelfClosingElement): string[] =>
  element.attributes.properties.flatMap((property) =>
    ts.isJsxAttribute(property) ? [property.name.getText(file)] : []);

/** An element-level props error (an unknown attribute, a missing required one).
 *  The compiler reports it once, on the tag, with both facts buried in a
 *  nested message; the AST carries them cleanly. */
const elementPropFindings = (
  ts: typeof TS,
  file: TS.SourceFile,
  checker: TS.TypeChecker,
  element: TS.JsxOpeningElement | TS.JsxSelfClosingElement,
): Finding[] => {
  const target = propsOf(ts, checker, element);
  if (target === undefined) return [];
  const component = element.tagName.getText(file);
  const written = writtenProps(ts, file, element);
  const allowed = new Set(target.all);
  const findings: Finding[] = [];
  for (const prop of written) {
    if (allowed.has(prop)) continue;
    findings.push({
      severity: "block",
      where: `<${component}> prop "${prop}"`,
      message: `sets unknown prop "${prop}" on <${component}>; the renderer drops it. Allowed props: ${target.all.join(", ") || "(none)"}`,
    });
  }
  for (const prop of target.required) {
    if (written.includes(prop)) continue;
    findings.push({
      severity: "block",
      where: `<${component}>`,
      message: `is missing required prop "${prop}" on <${component}>; the component cannot render without it. Its props are: ${target.all.join(", ")}`,
    });
  }
  return findings;
};

const propertyAccessFinding = (
  ts: typeof TS,
  file: TS.SourceFile,
  checker: TS.TypeChecker,
  locus: Locus,
  where: string,
): Finding | undefined => {
  const access = ts.isPropertyAccessExpression(locus.node) ? locus.node
    : (locus.node.parent !== undefined && ts.isPropertyAccessExpression(locus.node.parent) ? locus.node.parent : undefined);
  if (access === undefined) return undefined;
  const available = checker.getPropertiesOfType(checker.getTypeAtLocation(access.expression)).map((symbol) => symbol.getName());
  const field = access.name.getText(file);
  return {
    severity: "block",
    where,
    message: `reads field "${field}", which the tool's response shape does not carry`
      + `${available.length === 0 ? "" : ` — the real fields are: ${available.join(", ")}`}`,
  };
};

const argumentFinding = (
  ts: typeof TS,
  file: TS.SourceFile,
  checker: TS.TypeChecker,
  diagnostic: TS.Diagnostic,
  locus: Locus,
  where: string,
): Finding | undefined => {
  const start = diagnostic.start ?? 0;
  const end = start + (diagnostic.length ?? 0);
  const contains = (node: TS.Node): boolean => node.getStart(file) <= start && end <= node.getEnd();
  // The nearest CallExpression that has the diagnostic INSIDE AN ARGUMENT —
  // not merely around it. `group_by(rows, f, b, sum.of("nope"))` reports on the
  // whole `sum.of(...)` argument, whose own nearest CallExpression is itself.
  let call: TS.CallExpression | undefined;
  let index = -1;
  for (let current: TS.Node | undefined = locus.node; current !== undefined; current = current.parent) {
    if (!ts.isCallExpression(current)) continue;
    const at = current.arguments.findIndex(contains);
    if (at < 0) continue;
    call = current;
    index = at;
    break;
  }
  if (call === undefined) return undefined;
  const parameter = checker.getResolvedSignature(call)?.getParameters()[index];
  const wanted = parameter === undefined ? undefined : checker.getTypeOfSymbolAtLocation(parameter, call);
  const name = call.expression.getText(file);
  const written = call.arguments[index]?.getText(file) ?? "this argument";
  return {
    severity: "block",
    where,
    message: `${name}() does not accept ${written} as its ${ordinal(index + 1)} argument`
      + ` — that argument takes ${briefType(ts, checker, wanted)}. Name one the data really carries.`,
  };
};

const ORDINALS = ["", "1st", "2nd", "3rd", "4th", "5th"];
const ordinal = (position: number): string => ORDINALS[position] ?? `${position}th`;

const attributeValueFinding = (
  ts: typeof TS,
  file: TS.SourceFile,
  checker: TS.TypeChecker,
  locus: Locus,
  where: string,
): Finding | undefined => {
  if (locus.prop === undefined || locus.element === undefined) return undefined;
  const attribute = locus.element.attributes.properties.find((property) =>
    ts.isJsxAttribute(property) && property.name.getText(file) === locus.prop);
  if (attribute === undefined || !ts.isJsxAttribute(attribute) || attribute.initializer === undefined) return undefined;
  const value = ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : attribute.initializer;
  if (value === undefined) return undefined;
  const wanted = checker.getContextualType(value);
  return {
    severity: "block",
    where,
    message: `prop "${locus.prop}" on <${locus.element.tagName.getText(file)}> takes ${briefType(ts, checker, wanted)},`
      + ` but this value is ${briefType(ts, checker, checker.getTypeAtLocation(value))}`
      + " — bind a value whose type matches the prop",
  };
};

/** Diagnostic codes this module speaks for. Anything else falls through to a
 *  plainly-prefixed compiler sentence rather than being dropped: an unmapped
 *  code is still a real problem with the screen. */
const UNKNOWN_NAME = new Set([2304, 2552]);
const MISSING_PROPERTY = new Set([2339, 2551]);
const BAD_ARGUMENT = new Set([2345]);
const BAD_PROPS = new Set([2322, 2741, 2769, 2739, 2559]);

const translate = (
  ts: typeof TS,
  file: TS.SourceFile,
  checker: TS.TypeChecker,
  diagnostic: TS.Diagnostic,
): Finding[] => {
  const locus = locusOf(ts, file, diagnostic);
  const where = whereOf(file, diagnostic, locus);
  const code = diagnostic.code;

  if (UNKNOWN_NAME.has(code)) {
    const name = locus.node.getText(file);
    const isTag = locus.element !== undefined && locus.element.tagName.getText(file) === name;
    return [{
      severity: "block",
      where,
      message: isTag
        ? `references unknown component "${name}" — no host catalog entry, Kit component or prewired primitive carries that name`
        : `reads unknown name "${name}" — a screen may only read the queries it declares and the fixed call vocabulary`,
    }];
  }

  if (MISSING_PROPERTY.has(code)) {
    const finding = propertyAccessFinding(ts, file, checker, locus, where);
    if (finding !== undefined) return [finding];
  }

  if (BAD_ARGUMENT.has(code)) {
    const finding = argumentFinding(ts, file, checker, diagnostic, locus, where);
    if (finding !== undefined) return [finding];
  }

  if (BAD_PROPS.has(code) && locus.element !== undefined) {
    // The compiler anchors an element-level props error on the tag and a
    // value-level one on the attribute name; the locus tells them apart.
    const elementLevel = locus.prop === undefined
      || !writtenProps(ts, file, locus.element).every((prop) => propsOf(ts, checker, locus.element as TS.JsxOpeningElement)?.all.includes(prop) ?? true);
    if (elementLevel) {
      const findings = elementPropFindings(ts, file, checker, locus.element);
      if (findings.length > 0) return findings;
    }
    const finding = attributeValueFinding(ts, file, checker, locus, where);
    if (finding !== undefined) return [finding];
  }

  return [{
    severity: "block",
    where,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
  }];
};

/**
 * Type-check one screen against its generated declarations.
 *
 * Returns `[]` for a clean screen, `[]` when no usable compiler is available,
 * and never throws.
 */
export function screenTscFindings(input: ScreenTscInput): Finding[] {
  const ts = loadCompiler();
  if (ts === null) return [];
  try {
    const program = buildProgram(ts, input);
    const file = program.getSourceFile(SCREEN_FILE);
    if (file === undefined) return [];
    const syntactic = program.getSyntacticDiagnostics(file);
    if (syntactic.length > 0) {
      // Semantic diagnostics over a file that does not parse are a cascade of
      // consequences of the same break; report the break itself, once.
      const first = syntactic[0] as TS.Diagnostic;
      return [{
        severity: "block",
        where: `line ${file.getLineAndCharacterOfPosition(first.start ?? 0).line + 1}`,
        message: `does not parse as a screen: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`,
      }];
    }
    const checker = program.getTypeChecker();
    return program.getSemanticDiagnostics(file).flatMap((diagnostic) => translate(ts, file, checker, diagnostic));
  } catch {
    // The compiler is the check, not the product: a compiler that throws
    // degrades to no findings, exactly like one that would not load.
    return [];
  }
}
