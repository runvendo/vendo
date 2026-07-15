import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256Hex } from "@vendoai/core";
import {
  capturedPinBaselineSchema,
  type CapturedPinBaseline,
  type UnresolvedPin,
  type UnresolvedPinReason,
} from "../formats.js";
import {
  importReferenceFor,
  isInside,
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
  unresolved: UnresolvedPin[];
  warnings: string[];
}

const RUNTIME_CAPTURE_HINT = "run the host in dev with Vendo mounted to runtime-capture it";

function registrationFromBody(body: string, helperMarked: boolean): PinRegistration | null {
  let slot: string | undefined;
  let component: string | undefined;
  let remixable = helperMarked;
  let exportable = false;
  for (const rawField of splitTopLevel(body)) {
    const field = rawField.trim();
    const nameMatch = field.match(/^(?:["']name["']|name)\s*:\s*["']([^"']+)["']\s*$/s);
    if (nameMatch?.[1]) slot = nameMatch[1];
    const componentMatch = field.match(/^(?:["']component["']|component)\s*:\s*(.+)$/s);
    if (componentMatch?.[1]) component = componentMatch[1].trim();
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
    const helperMarked = /\bremixable\s*\(\s*$/.test(source.slice(Math.max(0, index - 80), index));
    const registration = registrationFromBody(body, helperMarked);
    if (registration) found.push(registration);
  }
  return found;
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

export async function capturePins(
  root: string,
  out: string,
  ignoreSlots: ReadonlySet<string> = new Set(),
): Promise<PinCaptureResult> {
  const result: PinCaptureResult = { captured: [], drifted: [], unresolved: [], warnings: [] };
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
      if (ignoreSlots.has(registration.slot)) continue;
      const baselineFile = path.resolve(remixableDir, `${registration.slot}.json`);
      if (!isInside(remixableDir, baselineFile)) {
        result.unresolved.push(unresolved(
          registration,
          "unsafe-slot",
          "rename the slot so it is a safe filename before capturing it",
        ));
        continue;
      }
      const fallbackPresent = async (): Promise<boolean> => hasCapturedBaseline(baselineFile, registration.slot);
      if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/.test(registration.component)) {
        if (!await fallbackPresent()) {
          result.unresolved.push(unresolved(
            registration,
            "inline-component",
            `use an imported component or ${RUNTIME_CAPTURE_HINT}`,
          ));
        }
        continue;
      }
      const reference = await importReferenceFor(source, registration.component);
      if (!reference) {
        if (!await fallbackPresent()) {
          result.unresolved.push(unresolved(
            registration,
            "component-not-imported",
            `use a static import or ${RUNTIME_CAPTURE_HINT}`,
          ));
        }
        continue;
      }
      const resolved = await resolveImportSource(file, reference.specifier, root, reference.imported);
      if (!resolved) {
        if (!await fallbackPresent()) {
          result.unresolved.push(unresolved(
            registration,
            "import-not-found",
            `fix the import path or ${RUNTIME_CAPTURE_HINT}`,
          ));
        }
        continue;
      }
      let realResolved: string;
      try {
        realResolved = await fs.realpath(resolved.file);
      } catch {
        if (!await fallbackPresent()) {
          result.unresolved.push(unresolved(
            registration,
            "unsafe-source",
            `keep the component source inside the host root or ${RUNTIME_CAPTURE_HINT}`,
          ));
        }
        continue;
      }
      if (!isInside(realRoot, realResolved)) {
        if (!await fallbackPresent()) {
          result.unresolved.push(unresolved(
            registration,
            "unsafe-source",
            `keep the component source inside the host root or ${RUNTIME_CAPTURE_HINT}`,
          ));
        }
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
  result.unresolved.sort((left, right) => left.slot.localeCompare(right.slot));
  return result;
}
