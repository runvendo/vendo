import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256Hex } from "@vendoai/core";
import {
  capturedPinBaselineSchema,
  type CapturedPinBaseline,
  type CapturedPinStyle,
  type CapturedPinSubSource,
  type UnresolvedPin,
  type UnresolvedPinReason,
} from "../formats.js";
import type TS from "typescript";
import {
  importReferenceFor,
  isInside,
  parseModuleSource,
  resolveImportSource,
  visitNodes,
  walk,
} from "./common.js";

const MAX_SUB_SOURCE_DEPTH = 2;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/u;
const ROOT_FILE = /^(?:src\/)?(?:app\/layout|app\/root|pages\/_app)\.(?:[cm]?[jt]sx?)$/u;
const BLESSED_JAIL_MODULES = new Set([
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
]);

interface PinRegistration {
  slot: string;
  component: string;
  remixable: boolean;
  exportable: boolean;
  sampleProps?: Record<string, unknown>;
  invalidSampleProps: boolean;
  /** Offset of the registration object literal's opening brace in its module source. */
  at: number;
}

export interface PinCaptureResult {
  captured: string[];
  drifted: string[];
  unresolved: UnresolvedPin[];
  warnings: string[];
}

const RUNTIME_CAPTURE_HINT = "run the host in dev with Vendo mounted to runtime-capture it";

const INVALID_STATIC_VALUE = Symbol("invalid-static-value");

/** Statically evaluate an expression to a JSON-compatible value: string,
 * number, boolean, and null literals, plus object and array literals of the
 * same. Anything dynamic — identifiers, calls, spreads, templates — is
 * invalid; sampleProps must be a value the runtime can replay verbatim. */
function staticJsonValue(ts: typeof TS, expression: TS.Expression): unknown {
  if (ts.isStringLiteral(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) {
    const value = Number(expression.text);
    return Number.isFinite(value) ? value : INVALID_STATIC_VALUE;
  }
  if (ts.isPrefixUnaryExpression(expression)
    && expression.operator === ts.SyntaxKind.MinusToken
    && ts.isNumericLiteral(expression.operand)) {
    const value = -Number(expression.operand.text);
    return Number.isFinite(value) ? value : INVALID_STATIC_VALUE;
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isObjectLiteralExpression(expression)) {
    const value = Object.create(null) as Record<string, unknown>;
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) return INVALID_STATIC_VALUE;
      const name = property.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) return INVALID_STATIC_VALUE;
      const item = staticJsonValue(ts, property.initializer);
      if (item === INVALID_STATIC_VALUE) return INVALID_STATIC_VALUE;
      value[name.text] = item;
    }
    return value;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const value: unknown[] = [];
    for (const element of expression.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return INVALID_STATIC_VALUE;
      const item = staticJsonValue(ts, element);
      if (item === INVALID_STATIC_VALUE) return INVALID_STATIC_VALUE;
      value.push(item);
    }
    return value;
  }
  return INVALID_STATIC_VALUE;
}

function staticSampleProps(ts: typeof TS, expression: TS.Expression): Record<string, unknown> | null {
  const parsed = staticJsonValue(ts, expression);
  return parsed !== INVALID_STATIC_VALUE && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function propertyName(ts: typeof TS, property: TS.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(property)) return null;
  const name = property.name;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

/** The registration is `remixable(…)`'s first argument. */
function isRemixableHelperArgument(ts: typeof TS, literal: TS.ObjectLiteralExpression): boolean {
  const parent = literal.parent;
  if (!ts.isCallExpression(parent) || parent.arguments[0] !== literal) return false;
  const callee = parent.expression;
  if (ts.isIdentifier(callee)) return callee.text === "remixable";
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "remixable";
}

function registrationFromLiteral(ts: typeof TS, sf: TS.SourceFile, literal: TS.ObjectLiteralExpression): PinRegistration | null {
  let slot: string | undefined;
  let component: string | undefined;
  let remixable = isRemixableHelperArgument(ts, literal);
  let exportable = false;
  let sampleProps: Record<string, unknown> | undefined;
  let invalidSampleProps = false;
  for (const property of literal.properties) {
    const name = propertyName(ts, property);
    if (name === null || !ts.isPropertyAssignment(property)) continue;
    const initializer = property.initializer;
    if (name === "name" && ts.isStringLiteral(initializer) && initializer.text.length > 0) slot = initializer.text;
    if (name === "component") component = initializer.getText(sf).trim();
    if (name === "remixable" && initializer.kind === ts.SyntaxKind.TrueKeyword) remixable = true;
    if (name === "exportable" && initializer.kind === ts.SyntaxKind.TrueKeyword) exportable = true;
    if (name === "sampleProps") {
      const parsed = staticSampleProps(ts, initializer);
      if (parsed === null) invalidSampleProps = true;
      else sampleProps = parsed;
    }
  }
  return slot && component
    ? {
        slot,
        component,
        remixable,
        exportable,
        invalidSampleProps,
        at: literal.getStart(sf),
        ...(sampleProps === undefined ? {} : { sampleProps }),
      }
    : null;
}

/** Every `{ name, component }` registration literal in one module, remixable or not. */
function registrations(source: string, fileName?: string): PinRegistration[] {
  // A registration needs a `component` property; the token's absence is a
  // cheap skip that avoids parsing every walked module.
  if (!source.includes("component")) return [];
  const parsed = parseModuleSource(source, fileName);
  if (!parsed) return [];
  const { ts, sf } = parsed;
  const found: PinRegistration[] = [];
  visitNodes(ts, sf, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const registration = registrationFromLiteral(ts, sf, node);
    if (registration) found.push(registration);
  });
  return found;
}

function portablePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function importSpecifiers(source: string, fileName?: string): string[] {
  const parsed = parseModuleSource(source, fileName);
  if (!parsed) return [];
  const { ts, sf } = parsed;
  const found: Array<{ at: number; specifier: string }> = [];
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.importClause?.isTypeOnly !== true) {
      found.push({ at: statement.getStart(sf), specifier: statement.moduleSpecifier.text });
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
      && !statement.isTypeOnly) {
      found.push({ at: statement.getStart(sf), specifier: statement.moduleSpecifier.text });
    }
  }
  visitNodes(ts, sf, (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument)) found.push({ at: node.getStart(sf), specifier: argument.text });
    }
  });
  found.sort((left, right) => left.at - right.at || left.specifier.localeCompare(right.specifier));
  return [...new Set(found.map(({ specifier }) => specifier))];
}

async function readExisting(file: string): Promise<{ exists: boolean; baseline: CapturedPinBaseline | null }> {
  try {
    const raw = await fs.readFile(file, "utf8");
    try {
      return { exists: true, baseline: capturedPinBaselineSchema.parse(JSON.parse(raw)) };
    } catch {
      return { exists: true, baseline: null };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, baseline: null };
    throw error;
  }
}

async function hasCapturedBaseline(file: string, slot: string): Promise<boolean> {
  const existing = await readExisting(file);
  return existing.baseline?.slot === slot;
}

function unresolved(
  registration: PinRegistration,
  reason: UnresolvedPinReason,
  hint: string,
): UnresolvedPin {
  return { slot: registration.slot, component: registration.component, reason, hint };
}

async function captureRootStyles(
  root: string,
  realRoot: string,
  files: readonly string[],
  warnings: string[],
): Promise<CapturedPinStyle[]> {
  const styles: CapturedPinStyle[] = [];
  const seen = new Set<string>();
  for (const rootFile of files.filter((file) => ROOT_FILE.test(portablePath(root, file)))) {
    const source = await fs.readFile(rootFile, "utf8");
    for (const specifier of importSpecifiers(source, rootFile).filter((value) => /\.css$/iu.test(value))) {
      const resolved = await resolveImportSource(rootFile, specifier, root);
      if (resolved === null) {
        warnings.push(`host app root ${portablePath(root, rootFile)} stylesheet import ${specifier} could not be resolved`);
        continue;
      }
      let realFile: string;
      try {
        realFile = await fs.realpath(resolved.file);
      } catch {
        warnings.push(`host app root ${portablePath(root, rootFile)} stylesheet import ${specifier} could not be resolved safely`);
        continue;
      }
      if (!isInside(realRoot, realFile)) {
        warnings.push(`host app root ${portablePath(root, rootFile)} stylesheet import ${specifier} resolves outside the host root and was not captured`);
        continue;
      }
      if (seen.has(realFile)) continue;
      seen.add(realFile);
      styles.push({ path: portablePath(realRoot, realFile), css: resolved.source });
    }
  }
  return styles;
}

interface CaptureTask {
  file: string;
  id: string | null;
  source: string;
  depth: number;
}

async function captureSubSources(
  root: string,
  realRoot: string,
  slot: string,
  primaryFile: string,
  primarySource: string,
  warnings: string[],
): Promise<{ sourceImports: Record<string, string>; subSources: Record<string, CapturedPinSubSource> }> {
  const sourceImports: Record<string, string> = {};
  const captured = new Map<string, CapturedPinSubSource>();
  const capturedDepth = new Map<string, number>();
  const queue: CaptureTask[] = [{ file: primaryFile, id: null, source: primarySource, depth: 0 }];

  while (queue.length > 0) {
    const task = queue.shift()!;
    const imports = task.id === null ? sourceImports : captured.get(task.id)!.imports;
    for (const specifier of importSpecifiers(task.source, task.file)) {
      if (BLESSED_JAIL_MODULES.has(specifier)) continue;
      const importer = task.id ?? portablePath(realRoot, primaryFile);
      if (/\.css(?:$|\?)/iu.test(specifier)) {
        warnings.push(`remixable slot ${slot} missed import ${specifier} from ${importer} (component stylesheet imports are not captured; use an app-root stylesheet)`);
        continue;
      }
      if (task.depth >= MAX_SUB_SOURCE_DEPTH) {
        warnings.push(`remixable slot ${slot} missed import ${specifier} from ${importer} (beyond capture depth ${MAX_SUB_SOURCE_DEPTH})`);
        continue;
      }
      const resolved = await resolveImportSource(task.file, specifier, root);
      if (resolved === null) {
        warnings.push(`remixable slot ${slot} missed import ${specifier} from ${importer} (could not be resolved)`);
        continue;
      }
      let realFile: string;
      try {
        realFile = await fs.realpath(resolved.file);
      } catch {
        warnings.push(`remixable slot ${slot} missed import ${specifier} from ${importer} (could not be resolved safely)`);
        continue;
      }
      if (!isInside(realRoot, realFile)) {
        warnings.push(`remixable slot ${slot} missed import ${specifier} from ${importer} (resolves outside the host root)`);
        continue;
      }
      if (!SOURCE_FILE.test(realFile)) {
        warnings.push(`remixable slot ${slot} missed import ${specifier} from ${importer} (not JavaScript/TypeScript source)`);
        continue;
      }
      const id = portablePath(realRoot, realFile);
      imports[specifier] = id;
      const depth = task.depth + 1;
      const previousDepth = capturedDepth.get(id);
      if (previousDepth !== undefined && previousDepth <= depth) continue;
      capturedDepth.set(id, depth);
      captured.set(id, { source: resolved.source, imports: {} });
      queue.push({ file: realFile, id, source: resolved.source, depth });
    }
  }

  const sortedSubSources = Object.fromEntries([...captured.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, module]) => [id, {
      source: module.source,
      imports: Object.fromEntries(Object.entries(module.imports).sort(([left], [right]) => left.localeCompare(right))),
    }]));
  return {
    sourceImports: Object.fromEntries(Object.entries(sourceImports).sort(([left], [right]) => left.localeCompare(right))),
    subSources: sortedSubSources,
  };
}

function sameCapturedPayload(left: CapturedPinBaseline | null, right: CapturedPinBaseline): boolean {
  if (left === null) return false;
  const payload = (baseline: CapturedPinBaseline) => ({
    slot: baseline.slot,
    source: baseline.source,
    hash: baseline.hash,
    exportable: baseline.exportable,
    sourceImports: baseline.sourceImports ?? {},
    subSources: baseline.subSources ?? {},
    sampleProps: baseline.sampleProps,
    styles: baseline.styles ?? [],
  });
  return JSON.stringify(payload(left)) === JSON.stringify(payload(right));
}

export async function capturePins(
  root: string,
  out: string,
  ignoreSlots: ReadonlySet<string> = new Set(),
): Promise<PinCaptureResult> {
  const result: PinCaptureResult = { captured: [], drifted: [], unresolved: [], warnings: [] };
  const realRoot = await fs.realpath(root);
  const files = await walk(root, (relativePath) => /\.(?:[cm]?[jt]sx?)$/u.test(relativePath) && !/\.d\.ts$/u.test(relativePath));
  let stylesPromise: Promise<CapturedPinStyle[]> | undefined;
  const seenSlots = new Set<string>();
  const remixableDir = path.join(out, "remixable");

  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    for (const registration of registrations(source, file).filter((candidate) => candidate.remixable)) {
      if (seenSlots.has(registration.slot)) {
        result.warnings.push(`remixable slot ${registration.slot} is registered more than once; kept the first registration`);
        continue;
      }
      seenSlots.add(registration.slot);
      if (ignoreSlots.has(registration.slot)) continue;
      if (registration.invalidSampleProps) {
        result.warnings.push(`remixable slot ${registration.slot} sampleProps is not a static JSON-compatible object and was not captured`);
      }
      const baselineFile = path.resolve(remixableDir, `${registration.slot}.json`);
      if (!isInside(remixableDir, baselineFile)) {
        result.unresolved.push(unresolved(
          registration,
          "unsafe-slot",
          "rename the slot so it is a safe filename before capturing it",
        ));
        continue;
      }
      // Unresolved is only reported when no runtime-captured baseline covers the slot.
      const skipUnresolved = async (reason: UnresolvedPinReason, hint: string): Promise<void> => {
        if (!(await hasCapturedBaseline(baselineFile, registration.slot))) {
          result.unresolved.push(unresolved(registration, reason, hint));
        }
      };
      if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/.test(registration.component)) {
        await skipUnresolved("inline-component", `use an imported component or ${RUNTIME_CAPTURE_HINT}`);
        continue;
      }
      const reference = await importReferenceFor(source, registration.component);
      if (!reference) {
        await skipUnresolved("component-not-imported", `use a static import or ${RUNTIME_CAPTURE_HINT}`);
        continue;
      }
      const resolved = await resolveImportSource(file, reference.specifier, root, reference.imported);
      if (!resolved) {
        await skipUnresolved("import-not-found", `fix the import path or ${RUNTIME_CAPTURE_HINT}`);
        continue;
      }
      let realResolved: string;
      try {
        realResolved = await fs.realpath(resolved.file);
      } catch {
        await skipUnresolved("unsafe-source", `keep the component source inside the host root or ${RUNTIME_CAPTURE_HINT}`);
        continue;
      }
      if (!isInside(realRoot, realResolved)) {
        await skipUnresolved("unsafe-source", `keep the component source inside the host root or ${RUNTIME_CAPTURE_HINT}`);
        continue;
      }
      const styles = await (stylesPromise ??= captureRootStyles(root, realRoot, files, result.warnings));
      const { sourceImports, subSources } = await captureSubSources(
        root,
        realRoot,
        registration.slot,
        realResolved,
        resolved.source,
        result.warnings,
      );
      const hash = `sha256:${sha256Hex(resolved.source)}`;
      const existing = await readExisting(baselineFile);
      const baseline: CapturedPinBaseline = {
        slot: registration.slot,
        source: resolved.source,
        hash,
        exportable: registration.exportable,
        capturedAt: new Date().toISOString(),
        ...(Object.keys(sourceImports).length === 0 ? {} : { sourceImports }),
        ...(Object.keys(subSources).length === 0 ? {} : { subSources }),
        ...(registration.sampleProps === undefined ? {} : { sampleProps: registration.sampleProps }),
        ...(styles.length === 0 ? {} : { styles }),
      };
      if (sameCapturedPayload(existing.baseline, baseline)) continue;
      await fs.mkdir(path.dirname(baselineFile), { recursive: true });
      await fs.writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
      (existing.exists ? result.drifted : result.captured).push(registration.slot);
    }
  }
  result.captured.sort();
  result.drifted.sort();
  result.unresolved.sort((left, right) => left.slot.localeCompare(right.slot));
  return result;
}
