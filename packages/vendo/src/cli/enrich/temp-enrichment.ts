// TEMP: deleted by judgment-layer lane C2.
//
// The judgment layer deleted `clampEnrichment`, `applyEnrichmentFields` and
// `gitTreeHash` from @vendoai/actions, and the `watermark` / `enriched` fields
// off the vendo/tools@3 type. Lane C2 replaces this whole `cli/enrich`
// directory with the judge channel; until it lands, these local copies keep
// build + typecheck green WITHOUT redesigning any CLI behavior. Nothing new
// lives here — every line is a verbatim lift of code deleted upstream.
//
// Runtime behavior is unchanged: `toolsFileSchema` and `extractedToolSchema`
// are passthrough, so the two dropped fields still round-trip through parse.
//
// DELETE THIS FILE with the rest of cli/enrich. Do not import it from anywhere
// else.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FieldSemantic } from "@vendoai/core";
import type { ExtractedTool, ToolsFile } from "@vendoai/actions";

const run = promisify(execFile);

/** TEMP (C2): the `enriched` provenance marker, deleted off ExtractedTool. */
export type EnrichedTool = ExtractedTool & { enriched?: boolean };

/** TEMP (C2): the `watermark` field, deleted off ToolsFile. */
export type WatermarkedToolsFile = Omit<ToolsFile, "tools"> & {
  tools: EnrichedTool[];
  watermark?: string;
};

export interface EnrichmentFields {
  description?: string;
  title?: string;
  risk?: ExtractedTool["risk"];
  critical?: boolean;
  disabled?: boolean;
  audience?: ExtractedTool["audience"];
  semantics?: Record<string, FieldSemantic>;
}

const RISK_RANK = { read: 0, write: 1, destructive: 2 } as const;
const AUDIENCE_RANK = { "end-user": 0, operator: 1, internal: 2 } as const;

export interface ClampedEnrichment {
  fields: EnrichmentFields;
  clamped: string[];
}

export function clampEnrichment(current: ExtractedTool, proposal: EnrichmentFields): ClampedEnrichment {
  const fields: EnrichmentFields = {};
  const clamped: string[] = [];

  if (proposal.description !== undefined && proposal.description !== current.description) {
    fields.description = proposal.description;
  }

  if (proposal.title !== undefined && proposal.title !== current.title) {
    fields.title = proposal.title;
  }

  if (proposal.risk !== undefined && proposal.risk !== current.risk) {
    if (RISK_RANK[proposal.risk] > RISK_RANK[current.risk]) fields.risk = proposal.risk;
    else clamped.push(`${current.name}: risk downgrade ${current.risk}→${proposal.risk} refused (loosen in overrides.json)`);
  }

  if (proposal.critical !== undefined && proposal.critical !== (current.critical ?? false)) {
    if (proposal.critical) fields.critical = true;
    else clamped.push(`${current.name}: clearing critical refused (loosen in overrides.json)`);
  }

  if (proposal.disabled !== undefined && proposal.disabled !== (current.disabled ?? false)) {
    if (proposal.disabled) fields.disabled = true;
    else clamped.push(`${current.name}: enabling a disabled tool refused (enable in overrides.json)`);
  }

  if (proposal.audience !== undefined && proposal.audience !== current.audience) {
    const currentRank = AUDIENCE_RANK[current.audience ?? "end-user"];
    if (AUDIENCE_RANK[proposal.audience] >= currentRank) fields.audience = proposal.audience;
    else clamped.push(`${current.name}: audience widening ${current.audience}→${proposal.audience} refused (loosen in overrides.json)`);
  }

  const audience = fields.audience ?? current.audience;
  if ((audience === "operator" || audience === "internal") && (fields.disabled ?? current.disabled) !== true) {
    fields.disabled = true;
  }

  if (proposal.semantics !== undefined && Object.keys(proposal.semantics).length > 0) {
    fields.semantics = proposal.semantics;
  }

  return { fields, clamped };
}

export function applyEnrichmentFields(tool: ExtractedTool, fields: EnrichmentFields): EnrichedTool {
  const { semantics, ...rest } = fields;
  const merged: EnrichedTool = { ...tool, ...rest, enriched: true };
  if (semantics !== undefined) {
    merged.semantics = { ...tool.semantics, ...semantics };
  }
  return merged;
}

export async function gitTreeHash(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: root });
    const hash = stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(hash) ? hash : undefined;
  } catch {
    return undefined;
  }
}
