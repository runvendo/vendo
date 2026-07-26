import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fieldSemanticSchema, type FieldSemantic, type ToolSemantics } from "@vendoai/core";
import { VENDO_TOOLS_FORMAT_V3 } from "@vendoai/actions";

/**
 * W3, retargeted for format v3 — per-tool field semantics live INSIDE
 * `.vendo/tools.json` (vendo/tools@3) now; there is no semantics.json.
 *
 * Per tool response field: `money(cents|dollars)`, `date(iso|epoch)`,
 * `enum(value→label)`, `id(entity)`, `percent(ratio|0-100)` — everything else
 * stays plain and is omitted. Priority per field:
 *
 *   1. host annotation (`overrides.json.tools[name].semantics`) — stays in the
 *      authored file and wins at merge time; it is never copied here
 *   2. what tools.json already says (inference runs ONCE — the sync engine
 *      carries entries across regenerations, so an inference never churns)
 *   3. fresh inference (the dev server samples each zero-input read tool at
 *      POST /sync/semantics and returns classifications, never values)
 *
 * The `domains` manifest is owned by the sync engine (derived from tool names
 * on first sync, host-curated afterwards) — not this module.
 */

export interface SemanticsSyncOptions {
  vendoDir: string;
  /** The dev-server wire base (same seam as /sync/impact). */
  url: string;
  fetchImpl?: typeof fetch;
  /** CLI-note sink (unreachable server, malformed file). */
  note: (message: string) => void;
}

const readJson = async (file: string): Promise<unknown | undefined> => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
};

interface InferredResponse {
  tools: Record<string, ToolSemantics>;
}

const fetchInferred = async (
  options: SemanticsSyncOptions,
): Promise<Record<string, ToolSemantics> | undefined> => {
  try {
    const response = await (options.fetchImpl ?? fetch)(`${options.url}/sync/semantics`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error(`sync semantics returned ${response.status}`);
    const body = await response.json() as InferredResponse;
    if (typeof body !== "object" || body === null || typeof body.tools !== "object" || body.tools === null) {
      throw new Error("invalid sync semantics response");
    }
    // Validate every entry; a malformed one drops rather than poisoning the file.
    const tools: Record<string, ToolSemantics> = {};
    for (const [tool, fields] of Object.entries(body.tools)) {
      const cleaned: ToolSemantics = {};
      for (const [path, semantic] of Object.entries(fields as Record<string, unknown>)) {
        const parsed = fieldSemanticSafe(semantic);
        if (parsed !== undefined) cleaned[path] = parsed;
      }
      if (Object.keys(cleaned).length > 0) tools[tool] = cleaned;
    }
    return tools;
  } catch {
    options.note(`semantics inference skipped — dev server not reachable at ${options.url}`);
    return undefined;
  }
};

const fieldSemanticSafe = (value: unknown): FieldSemantic | undefined => {
  const result = fieldSemanticSchema.safeParse(value);
  return result.success ? result.data : undefined;
};

/** Fetch one-time inference from the dev server and fold it into the v3
 *  tools.json per tool — existing entries win field-by-field, so a manual
 *  correction is never overwritten and an inference never churns. Operates on
 *  the RAW parsed JSON (no schema round-trip) so unknown additive fields
 *  survive the rewrite byte-exactly. Fail-soft: any problem becomes a note,
 *  never a sync failure. */
export async function syncSemantics(options: SemanticsSyncOptions): Promise<void> {
  const file = join(options.vendoDir, "tools.json");
  const raw = await readJson(file);
  if (raw === undefined || typeof raw !== "object" || raw === null) return; // nothing to describe
  const toolsFile = raw as { format?: unknown; tools?: unknown };
  // Legacy layouts are the sync engine's job (it rewrites the dir as v3
  // before this enrichment runs); anything non-v3 here is left alone.
  if (toolsFile.format !== VENDO_TOOLS_FORMAT_V3 || !Array.isArray(toolsFile.tools)) return;

  const inferred = await fetchInferred(options);
  if (inferred === undefined) return; // unreachable server — noted, file untouched

  for (const entry of toolsFile.tools) {
    if (entry === null || typeof entry !== "object") continue;
    const tool = entry as { name?: unknown; semantics?: Record<string, FieldSemantic> };
    if (typeof tool.name !== "string") continue;
    const merged: ToolSemantics = { ...inferred[tool.name], ...tool.semantics };
    if (Object.keys(merged).length > 0) tool.semantics = merged;
  }

  const bytes = `${JSON.stringify(toolsFile, null, 2)}\n`;
  try {
    if (await fs.readFile(file, "utf8") === bytes) return;
  } catch {
    // absent — write below
  }
  await fs.writeFile(file, bytes, "utf8");
}
