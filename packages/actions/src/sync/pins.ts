import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256Hex } from "@vendoai/core";
import { capturedPinBaselineSchema, type CapturedPinBaseline } from "../formats.js";
import {
  importSpecifierFor,
  resolveImportSource,
  splitTopLevel,
  topLevelObjectLiteral,
  walk,
} from "./common.js";

interface PinRegistration {
  slot: string;
  component: string;
  exportable: boolean;
}

export interface PinCaptureResult {
  captured: string[];
  drifted: string[];
  warnings: string[];
}

function registrationFromBody(body: string): PinRegistration | null {
  let slot: string | undefined;
  let component: string | undefined;
  let remixable = false;
  let exportable = false;
  for (const rawField of splitTopLevel(body)) {
    const field = rawField.trim();
    const nameMatch = field.match(/^(?:["']name["']|name)\s*:\s*["']([^"']+)["']\s*$/s);
    if (nameMatch?.[1]) slot = nameMatch[1];
    const componentMatch = field.match(/^(?:["']component["']|component)\s*:\s*([A-Za-z_$][\w$]*)\s*$/s);
    if (componentMatch?.[1]) component = componentMatch[1];
    if (/^(?:["']remixable["']|remixable)\s*:\s*true\s*$/s.test(field)) remixable = true;
    if (/^(?:["']exportable["']|exportable)\s*:\s*true\s*$/s.test(field)) exportable = true;
  }
  return remixable && slot && component ? { slot, component, exportable } : null;
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

export async function capturePins(root: string, out: string): Promise<PinCaptureResult> {
  const result: PinCaptureResult = { captured: [], drifted: [], warnings: [] };
  const realRoot = await fs.realpath(root);
  const files = await walk(root, (relativePath) => /\.(?:ts|tsx)$/.test(relativePath) && !/\.d\.ts$/.test(relativePath));
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
      const baselineFile = path.resolve(remixableDir, `${registration.slot}.json`);
      if (!isInside(remixableDir, baselineFile)) {
        result.warnings.push(`remixable slot ${registration.slot} is not a safe baseline filename and was not captured`);
        continue;
      }
      const hash = `sha256:${sha256Hex(resolved.source)}`;
      const existing = await readExisting(baselineFile);
      if (existing.baseline?.hash === hash) continue;
      const baseline: CapturedPinBaseline = {
        slot: registration.slot,
        source: resolved.source,
        hash,
        exportable: registration.exportable,
        capturedAt: new Date().toISOString(),
      };
      await fs.mkdir(path.dirname(baselineFile), { recursive: true });
      await fs.writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
      (existing.exists ? result.drifted : result.captured).push(registration.slot);
    }
  }
  result.captured.sort();
  result.drifted.sort();
  return result;
}
