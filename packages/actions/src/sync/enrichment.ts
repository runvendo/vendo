import type { FieldSemantic } from "@vendoai/core";
import type { ExtractedTool } from "../formats.js";

/**
 * The restrictive-only clamp (cse lane 1c) — the deterministic gate every AI
 * enrichment proposal passes before touching `.vendo/tools.json`. The spec's
 * safety rule is absolute: sync's AI may only make a tool MORE restrictive
 * than what is already on disk — raise risk, narrow audience, disable, mark
 * critical, rewrite prose (descriptions, semantics). It may NEVER lower risk,
 * widen audience, enable a disabled tool, or clear a critical mark; loosening
 * is a human act and lives in `overrides.json`. The clamp compares against
 * the CURRENT entry (deterministic baseline, or baseline + earlier
 * enrichment), so accepted judgments only ever ratchet tighter — an
 * over-tight AI call is undone by a human override, never by the next model
 * run. Tool identity, bindings, and inputSchema are not even expressible
 * here: `EnrichmentFields` is the whole AI-writable surface.
 */

export interface EnrichmentFields {
  description?: string;
  /** The short human label (see ToolDescriptor.title). PRESENTATION, not
   *  judgment: there is no loose/tight direction to a label, so the clamp lets
   *  it through freely — the only thing it can do wrong is read badly, and a
   *  human `overrides.json` title is the last word either way. */
  title?: string;
  risk?: ExtractedTool["risk"];
  critical?: boolean;
  disabled?: boolean;
  audience?: ExtractedTool["audience"];
  semantics?: Record<string, FieldSemantic>;
}

export const RISK_RANK = { read: 0, write: 1, destructive: 2 } as const;

/** Audience narrowing order: an ungraded tool behaves as end-user-visible, so
 *  end-user is the widest grade and internal the narrowest (non-end-user
 *  grades exclude the tool from the embedded agent by default). */
export const AUDIENCE_RANK = { "end-user": 0, operator: 1, internal: 2 } as const;

export interface ClampedEnrichment {
  /** The surviving (restrictive, non-no-op) subset of the proposal. */
  fields: EnrichmentFields;
  /** One human line per refused field — counted into the sync narrative. */
  clamped: string[];
}

/** Clamp one proposal against the current on-disk entry. Equal values drop
 *  silently (a no-op is not a violation); loosenings drop loudly. */
export function clampEnrichment(current: ExtractedTool, proposal: EnrichmentFields): ClampedEnrichment {
  const fields: EnrichmentFields = {};
  const clamped: string[] = [];

  if (proposal.description !== undefined && proposal.description !== current.description) {
    fields.description = proposal.description;
  }

  // Presentation, not judgment — accepted like a description rewrite, with no
  // restrictive direction to enforce.
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
    // An ungraded baseline behaves as end-user-visible: any grade on it is
    // provenance or a narrowing, never a widen.
    const currentRank = AUDIENCE_RANK[current.audience ?? "end-user"];
    if (AUDIENCE_RANK[proposal.audience] >= currentRank) fields.audience = proposal.audience;
    else clamped.push(`${current.name}: audience widening ${current.audience}→${proposal.audience} refused (loosen in overrides.json)`);
  }

  // Fail-closed exclusion (mirrors init's applyDraft): a non-end-user grade
  // excludes the tool from the embedded agent by default.
  const audience = fields.audience ?? current.audience;
  if ((audience === "operator" || audience === "internal") && (fields.disabled ?? current.disabled) !== true) {
    fields.disabled = true;
  }

  if (proposal.semantics !== undefined && Object.keys(proposal.semantics).length > 0) {
    fields.semantics = proposal.semantics;
  }

  return { fields, clamped };
}

/** Merge accepted fields into the entry and stamp the `enriched` marker
 *  (provenance: this entry's judgment fields were AI-reviewed). Proposed
 *  semantics merge per key over existing inference — they never wipe it. */
export function applyEnrichmentFields(tool: ExtractedTool, fields: EnrichmentFields): ExtractedTool {
  const { semantics, ...rest } = fields;
  const merged: ExtractedTool = { ...tool, ...rest, enriched: true };
  if (semantics !== undefined) {
    merged.semantics = { ...tool.semantics, ...semantics };
  }
  return merged;
}

/**
 * Carry the AI layer across structural syncs: `vendoSync` regenerates
 * `tools.json` wholesale, so a previously enriched entry (matched by name AND
 * binding identity by the caller) re-applies its judgment over the fresh
 * deterministic baseline — through the same clamp, so a scan that got MORE
 * restrictive since the enrichment (a fail-closed regrade, a new disable)
 * always wins over the stale carried grade.
 */
export function carryEnrichment(fresh: ExtractedTool, previous: ExtractedTool): ExtractedTool {
  const { fields } = clampEnrichment(fresh, {
    description: previous.description,
    ...(previous.title === undefined ? {} : { title: previous.title }),
    risk: previous.risk,
    ...(previous.critical === true ? { critical: true } : {}),
    ...(previous.disabled === true ? { disabled: true } : {}),
    ...(previous.audience === undefined ? {} : { audience: previous.audience }),
    ...(previous.semantics === undefined ? {} : { semantics: previous.semantics }),
  });
  return applyEnrichmentFields(fresh, fields);
}
