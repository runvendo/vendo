import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256Hex } from "@vendoai/core";
import {
  capturedPinBaselineSchema,
  type CapturedPinBaseline,
  type CapturedPinStyle,
  type CapturedPinSubSource,
} from "../formats.js";
import {
  importSpecifierFor,
  resolveImportSource,
  splitTopLevel,
  stripComments,
  topLevelObjectLiteral,
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
  exportable: boolean;
  sampleProps?: Record<string, unknown>;
  invalidSampleProps: boolean;
}

export interface PinCaptureResult {
  captured: string[];
  drifted: string[];
  warnings: string[];
}

class StaticValueParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.value();
    this.space();
    if (this.index !== this.source.length) throw new Error("unexpected trailing input");
    return value;
  }

  private space(): void {
    while (/\s/u.test(this.source[this.index] ?? "")) this.index += 1;
  }

  private value(): unknown {
    this.space();
    const character = this.source[this.index];
    if (character === "{" ) return this.object();
    if (character === "[") return this.array();
    if (character === "\"" || character === "'") return this.string();
    const rest = this.source.slice(this.index);
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (rest.startsWith(literal) && !/[A-Za-z0-9_$]/u.test(rest[literal.length] ?? "")) {
        this.index += literal.length;
        return value;
      }
    }
    const number = rest.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (number !== undefined) {
      this.index += number.length;
      const value = Number(number);
      if (Number.isFinite(value)) return value;
    }
    throw new Error("sampleProps must be a static JSON-compatible value");
  }

  private string(): string {
    const quote = this.source[this.index++];
    let value = "";
    while (this.index < this.source.length) {
      const character = this.source[this.index++];
      if (character === quote) return value;
      if (character !== "\\") {
        value += character;
        continue;
      }
      const escaped = this.source[this.index++];
      const simple: Record<string, string> = {
        "\"": "\"", "'": "'", "\\": "\\", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
      };
      if (escaped !== undefined && simple[escaped] !== undefined) {
        value += simple[escaped];
        continue;
      }
      if (escaped === "u") {
        const hex = this.source.slice(this.index, this.index + 4);
        if (!/^[0-9a-f]{4}$/iu.test(hex)) throw new Error("invalid unicode escape");
        value += String.fromCharCode(Number.parseInt(hex, 16));
        this.index += 4;
        continue;
      }
      throw new Error("unsupported string escape");
    }
    throw new Error("unterminated string");
  }

  private key(): string {
    this.space();
    if (this.source[this.index] === "\"" || this.source[this.index] === "'") return this.string();
    const identifier = this.source.slice(this.index).match(/^[A-Za-z_$][\w$]*/u)?.[0];
    if (identifier === undefined) throw new Error("object keys must be static");
    this.index += identifier.length;
    return identifier;
  }

  private object(): Record<string, unknown> {
    this.index += 1;
    const value = Object.create(null) as Record<string, unknown>;
    this.space();
    while (this.source[this.index] !== "}") {
      const key = this.key();
      this.space();
      if (this.source[this.index++] !== ":") throw new Error("object property needs a colon");
      value[key] = this.value();
      this.space();
      if (this.source[this.index] === "}") break;
      if (this.source[this.index++] !== ",") throw new Error("object properties need commas");
      this.space();
      if (this.source[this.index] === "}") break;
    }
    if (this.source[this.index++] !== "}") throw new Error("unterminated object");
    return value;
  }

  private array(): unknown[] {
    this.index += 1;
    const value: unknown[] = [];
    this.space();
    while (this.source[this.index] !== "]") {
      value.push(this.value());
      this.space();
      if (this.source[this.index] === "]") break;
      if (this.source[this.index++] !== ",") throw new Error("array items need commas");
      this.space();
      if (this.source[this.index] === "]") break;
    }
    if (this.source[this.index++] !== "]") throw new Error("unterminated array");
    return value;
  }
}

function staticSampleProps(source: string): Record<string, unknown> | null {
  try {
    const parsed = new StaticValueParser(source).parse();
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function registrationFromBody(body: string): PinRegistration | null {
  let slot: string | undefined;
  let component: string | undefined;
  let remixable = false;
  let exportable = false;
  let sampleProps: Record<string, unknown> | undefined;
  let invalidSampleProps = false;
  for (const rawField of splitTopLevel(body)) {
    const field = rawField.trim();
    const nameMatch = field.match(/^(?:["']name["']|name)\s*:\s*["']([^"']+)["']\s*$/su);
    if (nameMatch?.[1]) slot = nameMatch[1];
    const componentMatch = field.match(/^(?:["']component["']|component)\s*:\s*([A-Za-z_$][\w$]*)\s*$/su);
    if (componentMatch?.[1]) component = componentMatch[1];
    if (/^(?:["']remixable["']|remixable)\s*:\s*true\s*$/su.test(field)) remixable = true;
    if (/^(?:["']exportable["']|exportable)\s*:\s*true\s*$/su.test(field)) exportable = true;
    const sampleMatch = field.match(/^(?:["']sampleProps["']|sampleProps)\s*:\s*([\s\S]+)$/u);
    if (sampleMatch?.[1] !== undefined) {
      const parsed = staticSampleProps(sampleMatch[1]);
      if (parsed === null) invalidSampleProps = true;
      else sampleProps = parsed;
    }
  }
  return remixable && slot && component
    ? { slot, component, exportable, invalidSampleProps, ...(sampleProps === undefined ? {} : { sampleProps }) }
    : null;
}

function registrations(source: string): PinRegistration[] {
  const found: PinRegistration[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "{") continue;
    const body = topLevelObjectLiteral(source, index);
    if (!body) continue;
    const registration = registrationFromBody(body);
    if (registration) found.push(registration);
  }
  return found;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function portablePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function importSpecifiers(source: string): string[] {
  const withoutTypes = stripComments(source)
    .replace(/\bimport\s+type\b[^;]*(?:;|$)/gmu, "")
    .replace(/\bexport\s+type\b[^;]*(?:;|$)/gmu, "");
  const found: Array<{ at: number; specifier: string }> = [];
  const staticImport = /\bimport\s+(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/gmu;
  const reExport = /\bexport\s+[^"'`;]*?\s+from\s+["']([^"']+)["']/gmu;
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gmu;
  for (const pattern of [staticImport, reExport, dynamicImport]) {
    for (const match of withoutTypes.matchAll(pattern)) {
      if (match[1] !== undefined && match.index !== undefined) found.push({ at: match.index, specifier: match[1] });
    }
  }
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
    for (const specifier of importSpecifiers(source).filter((value) => /\.css$/iu.test(value))) {
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
    for (const specifier of importSpecifiers(task.source)) {
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

export async function capturePins(root: string, out: string): Promise<PinCaptureResult> {
  const result: PinCaptureResult = { captured: [], drifted: [], warnings: [] };
  const realRoot = await fs.realpath(root);
  const files = await walk(root, (relativePath) => /\.(?:[cm]?[jt]sx?)$/u.test(relativePath) && !/\.d\.ts$/u.test(relativePath));
  let stylesPromise: Promise<CapturedPinStyle[]> | undefined;
  const seenSlots = new Set<string>();
  const remixableDir = path.join(out, "remixable");

  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    for (const registration of registrations(source)) {
      if (seenSlots.has(registration.slot)) {
        result.warnings.push(`remixable slot ${registration.slot} is registered more than once; kept the first registration`);
        continue;
      }
      seenSlots.add(registration.slot);
      if (registration.invalidSampleProps) {
        result.warnings.push(`remixable slot ${registration.slot} sampleProps is not a static JSON-compatible object and was not captured`);
      }
      const specifier = importSpecifierFor(source, registration.component);
      if (!specifier) {
        result.warnings.push(`remixable slot ${registration.slot} component ${registration.component} is not a resolvable import`);
        continue;
      }
      const resolved = await resolveImportSource(file, specifier, root);
      if (!resolved) {
        result.warnings.push(`remixable slot ${registration.slot} component import ${specifier} could not be resolved`);
        continue;
      }
      let realResolved: string;
      try {
        realResolved = await fs.realpath(resolved.file);
      } catch {
        result.warnings.push(`remixable slot ${registration.slot} component source could not be resolved safely`);
        continue;
      }
      if (!isInside(realRoot, realResolved)) {
        result.warnings.push(`remixable slot ${registration.slot} resolves outside the host root and was not captured`);
        continue;
      }
      const styles = await (stylesPromise ??= captureRootStyles(root, realRoot, files, result.warnings));
      const baselineFile = path.resolve(remixableDir, `${registration.slot}.json`);
      if (!isInside(remixableDir, baselineFile)) {
        result.warnings.push(`remixable slot ${registration.slot} is not a safe baseline filename and was not captured`);
        continue;
      }
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
  return result;
}
