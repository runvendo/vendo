/**
 * Read the `.vendo/` directory (`vendo init`'s output) from disk.
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
} from "@vendoai/core";
import { brandTokensSchema, defaultBrand, type BrandTokens } from "@vendoai/components/theme";
import type { McpServerConfig } from "@vendoai/runtime";
import { mcpJsonSchema } from "./mcp-config";

export interface LoadedVendoDir {
  brand: BrandTokens;
  manifest: ToolsManifest;
  /** `vendo sync` capture: anchorId → captured component source. */
  remixSources: Record<string, RemixSourceRecord>;
  /** `vendo sync` environment manifest, when the env was built. */
  envManifest?: EnvManifest;
  /** Raw (pre-env-substitution) servers from mcp.json; absent file → undefined. */
  mcpServers?: McpServerConfig[];
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
  styles: z.object({ css: z.boolean(), tailwind: z.boolean() }).optional(),
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

export function loadVendoDir(dir: string = path.join(process.cwd(), ".vendo")): LoadedVendoDir {
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

  // vendo sync artifacts — same contract: absent → defaults, invalid → loud.
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

  const mcpRaw = readJson(path.join(dir, "mcp.json"));
  let mcpServers: McpServerConfig[] | undefined;
  if (mcpRaw !== undefined) {
    const parsed = mcpJsonSchema.safeParse(mcpRaw);
    if (!parsed.success) {
      throw new Error(`mcp.json does not match the MCP servers schema: ${parsed.error.message}`);
    }
    mcpServers = parsed.data.servers;
  }

  return {
    brand,
    manifest,
    remixSources,
    ...(envManifest ? { envManifest } : {}),
    ...(mcpServers ? { mcpServers } : {}),
  };
}
