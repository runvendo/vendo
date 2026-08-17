/**
 * One screen, compiled — with the compiler HANDED OVER, and its standard library
 * with it.
 *
 * This is `screen-tsc.ts` minus the one thing that made it Node's: the compiler
 * loader. Everything here — the in-memory compiler host, the options a screen is
 * checked under, and the translation of a diagnostic into the floor's sentence —
 * needs a filesystem for nothing, so it runs wherever the caller found a
 * compiler. `screen-tsc.ts` is that caller on Node, resolving `typescript`
 * through `createRequire` and answering the lib files off disk;
 * `server/edge/typecheck.ts` is that caller on a Worker, importing the compiler
 * and answering the lib files out of a `Map`.
 *
 * THE SPLIT IS THE POINT, and it is structural rather than careful. A single
 * `import { createRequire } from "node:module"` at the top of `screen-tsc.ts` is
 * emitted into any bundle that reaches this module — esbuild keeps the external
 * import statement even after tree-shaking away every consumer, and `sideEffects:
 * false` does not change that. Under workerd without `nodejs_compat` the whole
 * worker then refuses to START, before a single request: `No such module
 * "node:module"`. A lazy import would have depended on bundler behaviour and on
 * whichever externals a consumer configured; a module boundary cannot be
 * defeated by either. Nothing under this file may import a Node builtin.
 *
 * The sentences are written from the AST, not scraped from the compiler's prose:
 * a raw `TS2322` dump naming two anonymous object types is unactionable, where
 * "sets unknown prop \"data\" on <Table>; the renderer drops it. Allowed props:
 * columns, rows, …" is the same sentence the bespoke checks already speak. They
 * live here, not with either caller, because a screen author must read the same
 * sentence whatever compiled the screen.
 */
import type TS from "typescript";
import { SCREEN_TYPINGS_FILE } from "./screen-typings.js";
import type { Finding } from "./types.js";

/** The screen file's virtual path. Its text is used VERBATIM, so a finding's
 *  line numbers are the author's line numbers. */
const SCREEN_FILE = "/screen.tsx";

export interface ScreenTscInput {
  /** The screen file's text, verbatim. */
  readonly screen: string;
  /** The ambient declarations from {@link screenTypings}. */
  readonly typings: string;
  /**
   * The standard library, when the default is too small. The wire screen is
   * declarative and needs nothing past ES5; a COMPONENT screen awaits tool
   * calls, so it needs a `Promise`. No DOM lib is available in either case —
   * that is deliberate, not an omission.
   */
  readonly lib?: readonly string[];
}

/** Parsed lib files, keyed by path. A program costs ~450ms cold and ~5ms warm,
 *  and the lib files are immutable for the process. */
const libCache = new Map<string, TS.SourceFile>();

const compilerOptions = (ts: typeof TS, input: ScreenTscInput): TS.CompilerOptions => ({
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ES2020,
  // The smallest lib carrying Array/ReadonlyArray/Record — a screen is
  // declarative, so nothing here needs a newer standard library.
  lib: [...(input.lib ?? ["lib.es5.d.ts"])],
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

/**
 * The standard library, as the compiler host asks for it. `ts.sys` is Node's
 * disk; a venue without one carries its libs some other way, which is the whole
 * reason this is an argument.
 *
 * `exists` is separate from `read` because the compiler PROBES far more files
 * than it reads, and a lib file is hundreds of kilobytes: answering existence by
 * reading the body would pay for every probe, and would call a file that exists
 * but cannot be read absent. An in-memory provider answers both with one lookup.
 */
export interface LibTextProvider {
  read(fileName: string): string | undefined;
  exists(fileName: string): boolean;
}

const buildProgram = (
  ts: typeof TS,
  input: ScreenTscInput,
  libs: LibTextProvider,
  defaultLibFileName: (options: TS.CompilerOptions) => string,
): TS.Program => {
  const options = compilerOptions(ts, input);
  const files = new Map([[SCREEN_FILE, input.screen], [SCREEN_TYPINGS_FILE, input.typings]]);
  const create = (name: string, text: string, version: TS.ScriptTarget | TS.CreateSourceFileOptions): TS.SourceFile =>
    ts.createSourceFile(name, text, version, true, name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const host: TS.CompilerHost = {
    getSourceFile: (name, version) => {
      const own = files.get(name);
      if (own !== undefined) return create(name, own, version);
      const cached = libCache.get(name);
      if (cached !== undefined) return cached;
      const text = libs.read(name);
      if (text === undefined) return undefined;
      const file = create(name, text, version);
      libCache.set(name, file);
      return file;
    },
    getDefaultLibFileName: defaultLibFileName,
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => files.has(name) || libs.exists(name),
    readFile: (name) => files.get(name) ?? libs.read(name),
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
    ts.isJsxAttribute(property) ? [property.name.getText(file)] : [])
    // `key` is React's own (JSX.IntrinsicAttributes), never a component's — and a
    // mapped row must write one, so reporting it would bury the real fault.
    .filter((name) => name !== "key");

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
 * One compiled screen, for a caller that writes its OWN sentences.
 *
 * `ok: false` NAMES why nothing was checked, instead of returning silence a
 * caller cannot tell apart from a clean screen. That distinction is the point:
 * the wire screen's check degrades to no findings by policy (below), while the
 * component screen's gauntlet treats an unreachable compiler as a failure —
 * a gate that cannot read the file must not pass it.
 */
export type ScreenProgram =
  | {
      ok: true;
      ts: typeof TS;
      file: TS.SourceFile;
      checker: TS.TypeChecker;
      /** Syntax errors. Semantic diagnostics over a file that does not parse
       *  are a cascade of consequences of the same break, so `semantic` is
       *  empty whenever this is not. */
      syntactic: readonly TS.Diagnostic[];
      semantic: readonly TS.Diagnostic[];
    }
  | { ok: false; why: string };

/** Build the program and collect its diagnostics, with the compiler and its
 *  standard library HANDED OVER — for a caller that resolved both somewhere this
 *  package cannot reach (`checking/toolchain.ts`). Never throws. */
export function screenProgramWith(
  ts: typeof TS,
  input: ScreenTscInput,
  libs: LibTextProvider,
  defaultLibFileName: (options: TS.CompilerOptions) => string,
): ScreenProgram {
  try {
    const program = buildProgram(ts, input, libs, defaultLibFileName);
    const file = program.getSourceFile(SCREEN_FILE);
    if (file === undefined) return { ok: false, why: "the compiler did not accept the screen file" };
    const syntactic = program.getSyntacticDiagnostics(file);
    return {
      ok: true,
      ts,
      file,
      checker: program.getTypeChecker(),
      syntactic,
      semantic: syntactic.length > 0 ? [] : program.getSemanticDiagnostics(file),
    };
  } catch (error) {
    return { ok: false, why: `the TypeScript compiler threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** One diagnostic as the floor's sentence. Exported for the component screen's
 *  gauntlet, which overrides the handful of classes whose prose is specific to
 *  the wire dialect and reuses the rest of this translation. */
export function translateDiagnostic(
  ts: typeof TS,
  file: TS.SourceFile,
  checker: TS.TypeChecker,
  diagnostic: TS.Diagnostic,
): Finding[] {
  return translate(ts, file, checker, diagnostic);
}

/** A diagnostic's 1-based line in the screen file — the author's own line. */
export const diagnosticLine = (file: TS.SourceFile, diagnostic: TS.Diagnostic): number =>
  file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
