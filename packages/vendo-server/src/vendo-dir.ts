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
import { toolsManifestSchema, type ToolsManifest } from "@vendoai/core";
import { brandTokensSchema, defaultBrand, type BrandTokens } from "@vendoai/components/theme";
import type { McpServerConfig } from "@vendoai/runtime";
import { mcpJsonSchema } from "./mcp-config.js";

export interface LoadedVendoDir {
  brand: BrandTokens;
  manifest: ToolsManifest;
  /** Raw (pre-env-substitution) servers from mcp.json; absent file → undefined. */
  mcpServers?: McpServerConfig[];
}

const EMPTY_MANIFEST: ToolsManifest = { version: 1, tools: [], events: [] };

function readJson(file: string): unknown | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    // Only ENOENT means "absent → caller defaults". Anything else (EACCES,
    // EIO, EISDIR) is a PRESENT-but-unreadable file — silently serving
    // defaults would drop the developer's config (empty tool manifest,
    // default brand) with no signal, so fail boot loudly instead.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `[vendo] ${path.basename(file)} exists but could not be read (${file}): ${err instanceof Error ? err.message : String(err)}`,
    );
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
    ...(mcpServers ? { mcpServers } : {}),
  };
}
