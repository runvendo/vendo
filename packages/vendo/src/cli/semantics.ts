import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  fieldSemanticSchema,
  semanticsFileSchema,
  VENDO_SEMANTICS_FORMAT,
  type FieldSemantic,
  type SemanticsFile,
  type ToolSemantics,
} from "@vendoai/core";
import { overridesFileSchema, toolsFileSchema } from "@vendoai/actions";

/**
 * W3 (v3 spec §Context) — `.vendo/semantics.json`, written by `vendo sync`.
 *
 * Per tool response field: `money(cents|dollars)`, `date(iso|epoch)`,
 * `enum(value→label)`, `id(entity)`, `percent(ratio|0-100)` — everything else
 * stays plain and is omitted. Priority per field:
 *
 *   1. host annotation (`overrides.json.tools[name].semantics`)
 *   2. what this file already says (inference runs ONCE — a host edit here
 *      is never overwritten, and an inference never churns)
 *   3. fresh inference (the dev server samples each zero-input read tool at
 *      POST /sync/semantics and returns classifications, never values)
 *
 * The `domains` manifest (has / has-NOT) is derived from tool names on FIRST
 * sync and host-owned afterwards.
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

/** Verb tokens dropped from a tool name when deriving its data domain. */
const NAME_VERBS = /^(get|list|create|update|delete|set|send|reset|simulate|search|fetch|read|add|remove|post|put|patch)$/i;
/** Whole tools that are plumbing, not a data domain. */
const NOISE_TOKENS = /^(auth|demo|voice|session|sessions|webhook|webhooks|health|ping)$/i;

/** host_listAccountTransactions → "account transactions". */
export const domainFromToolName = (name: string): string | undefined => {
  const tokens = name
    .replace(/^host_/, "")
    .split(/[_.]/)
    .flatMap((part) => part.split(/(?=[A-Z])/))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
  if (tokens.some((token) => NOISE_TOKENS.test(token))) return undefined;
  const nouns = tokens.filter((token) => !NAME_VERBS.test(token));
  if (nouns.length === 0) return undefined;
  return nouns.join(" ");
};

export const deriveDomains = (toolNames: readonly string[]): string[] =>
  [...new Set(toolNames.map(domainFromToolName).filter((domain): domain is string => domain !== undefined))].sort();

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

/** Read tools + annotations + the existing file, fetch one-time inference,
 *  merge by priority, and write `.vendo/semantics.json`. Fail-soft: any
 *  problem becomes a note, never a sync failure. */
export async function syncSemantics(options: SemanticsSyncOptions): Promise<void> {
  const toolsRaw = await readJson(join(options.vendoDir, "tools.json"));
  const toolsParse = toolsFileSchema.safeParse(toolsRaw);
  if (!toolsParse.success) return; // no tools file → nothing to describe
  const toolNames = toolsParse.data.tools.map((tool) => tool.name);

  const overridesRaw = await readJson(join(options.vendoDir, "overrides.json"));
  const overridesParse = overridesFileSchema.safeParse(overridesRaw);
  const annotations: Record<string, ToolSemantics> = {};
  if (overridesParse.success) {
    for (const [tool, override] of Object.entries(overridesParse.data.tools)) {
      if (override.semantics !== undefined) annotations[tool] = override.semantics;
    }
  }

  const file = join(options.vendoDir, "semantics.json");
  const existingRaw = await readJson(file);
  const existingParse = semanticsFileSchema.safeParse(existingRaw);
  const existing: SemanticsFile | undefined = existingParse.success ? existingParse.data : undefined;
  if (existingRaw !== undefined && existing === undefined) {
    options.note("semantics.json is malformed; regenerating it (host edits in the old file are not carried over)");
  }

  const inferred = await fetchInferred(options) ?? {};

  const tools: Record<string, ToolSemantics> = {};
  for (const name of toolNames) {
    const merged: ToolSemantics = {
      ...inferred[name],
      ...existing?.tools[name],
      ...annotations[name],
    };
    if (Object.keys(merged).length > 0) tools[name] = merged;
  }

  const next: SemanticsFile & { note: string } = {
    format: VENDO_SEMANTICS_FORMAT,
    note: "Generated by `vendo sync` and safe to edit: field entries are inferred ONCE and your edits are preserved; overrides.json tools[name].semantics wins over everything. `domains` is derived from tool names on first sync and yours afterwards — keep has/hasNot honest, generation treats them as fact.",
    tools,
    // First sync derives the positive list; afterwards the manifest is
    // host-owned (curation survives every sync).
    domains: existing?.domains ?? { has: deriveDomains(toolNames), hasNot: [] },
  };
  const bytes = `${JSON.stringify(next, null, 2)}\n`;
  try {
    if (await fs.readFile(file, "utf8") === bytes) return;
  } catch {
    // absent — write below
  }
  await fs.writeFile(file, bytes, "utf8");
}
