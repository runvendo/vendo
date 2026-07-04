/**
 * Read the `.flowlet/` directory (`flowlet init`'s output) from disk.
 *
 * Zero-config contract: a missing directory or file falls back to safe
 * defaults (default brand, empty tool manifest) so chat + generated UI work
 * on an app with nothing extracted yet. A PRESENT-but-invalid file fails loud
 * — these are developer-editable files and silently ignoring an edit is worse
 * than an error at boot.
 *
 * Server-only (node:fs).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  toolsManifestSchema,
  type EnvManifest,
  type RemixSourceRecord,
  type ToolsManifest,
} from "@flowlet/core";
import { brandTokensSchema, defaultBrand, type BrandTokens } from "@flowlet/components/theme";

export interface LoadedFlowletDir {
  brand: BrandTokens;
  manifest: ToolsManifest;
  /** `flowlet sync` capture: anchorId → captured component source. */
  remixSources: Record<string, RemixSourceRecord>;
  /** `flowlet sync` environment manifest, when the env was built. */
  envManifest?: EnvManifest;
}

const remixSourceRecordSchema = z.object({
  file: z.string().min(1),
  exportName: z.string().optional(),
  source: z.string(),
  sourceHash: z.string().min(1),
  capturedAt: z.string().min(1),
});
const remixSourcesSchema = z.record(z.string(), remixSourceRecordSchema);

const envImportStatusSchema = z.union([
  z.object({ kind: z.literal("real") }),
  z.object({ kind: z.literal("shimmed"), note: z.string() }),
  z.object({ kind: z.literal("absent"), alternative: z.string() }),
]);
const envManifestSchema = z.object({
  anchors: z.record(z.string(), z.record(z.string(), envImportStatusSchema)),
  vendorSizes: z.record(z.string(), z.number()).optional(),
});

const EMPTY_MANIFEST: ToolsManifest = { version: 1, tools: [], events: [] };

function readJson(file: string): unknown | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined; // absent → caller defaults
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${path.basename(file)} is not valid JSON (${file}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function loadFlowletDir(dir: string = path.join(process.cwd(), ".flowlet")): LoadedFlowletDir {
  const themeRaw = readJson(path.join(dir, "theme.json"));
  const toolsRaw = readJson(path.join(dir, "tools.json"));

  let brand = defaultBrand;
  if (themeRaw !== undefined) {
    const parsed = brandTokensSchema.safeParse(themeRaw);
    if (!parsed.success) {
      throw new Error(`theme.json does not match the brand-token schema: ${parsed.error.message}`);
    }
    brand = parsed.data;
  }

  let manifest = EMPTY_MANIFEST;
  if (toolsRaw !== undefined) {
    const parsed = toolsManifestSchema.safeParse(toolsRaw);
    if (!parsed.success) {
      throw new Error(`tools.json does not match the tools-manifest schema: ${parsed.error.message}`);
    }
    manifest = parsed.data;
  }

  // flowlet sync artifacts — same contract: absent → defaults, invalid → loud.
  let remixSources: Record<string, RemixSourceRecord> = {};
  const remixRaw = readJson(path.join(dir, "remix-sources.json"));
  if (remixRaw !== undefined) {
    const parsed = remixSourcesSchema.safeParse(remixRaw);
    if (!parsed.success) {
      throw new Error(
        `remix-sources.json does not match the remix-source schema: ${parsed.error.message}`,
      );
    }
    remixSources = parsed.data;
  }

  let envManifest: EnvManifest | undefined;
  const envRaw = readJson(path.join(dir, "env", "manifest.json"));
  if (envRaw !== undefined) {
    const parsed = envManifestSchema.safeParse(envRaw);
    if (!parsed.success) {
      throw new Error(`env/manifest.json does not match the env-manifest schema: ${parsed.error.message}`);
    }
    envManifest = parsed.data;
  }

  return { brand, manifest, remixSources, ...(envManifest ? { envManifest } : {}) };
}
