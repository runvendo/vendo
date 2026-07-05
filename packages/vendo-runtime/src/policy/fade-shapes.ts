/**
 * Fade shape derivation (ENG-193 spec §4.4) — deterministic, no model in the
 * loop. Every act-tier yes/no decision is filed under exactly one shape, so
 * "is this the 3rd yes of the same kind" is a pure structural question.
 *
 * Heuristic (orchestrator scope ruling, 2026-07-04):
 *  1. First input field whose STRING value looks like an email -> a
 *     `matches` constraint on that field, narrowed to the email's DOMAIN
 *     (never the literal address — "reminder emails to your clients", not
 *     one person).
 *  2. Else the first field named type/kind/status/category with a string
 *     value -> an `eq` constraint on that field.
 *  3. Else tool-wide ({kind:"tool"}) — the fallback every input can reach.
 *
 * `computeProposalId` is a hash, not an opaque random id, ON PURPOSE: the
 * server never needs to remember it to know what it means — `FadeTracker`
 * still keeps a small offered-proposal map (fade-tracker.ts) so it never has
 * to re-derive a shape from a client-supplied value, but the hash itself
 * guarantees the SAME shape always gets the SAME id (idempotent re-offers).
 */
import type { FadeShape, GrantScope } from "@vendoai/core";
import { canonicalJson, fnv1a64 } from "../hashing.js";

const EMAIL_RE = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;
const TYPE_FIELD_NAMES = ["type", "kind", "status", "category"];

export function deriveFadeShape(input: unknown): FadeShape {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { kind: "tool" };
  }
  const obj = input as Record<string, unknown>;
  for (const [path, value] of Object.entries(obj)) {
    if (typeof value !== "string") continue;
    const m = EMAIL_RE.exec(value);
    if (m) return { kind: "constrained", path, op: "matches", value: `*@${m[1]}` };
  }
  for (const name of TYPE_FIELD_NAMES) {
    const value = obj[name];
    if (typeof value === "string") return { kind: "constrained", path: name, op: "eq", value };
  }
  return { kind: "tool" };
}

/** Stable string key for window/suppression bucketing — two shapes with the
 *  same key are the "same kind" of decision (ENG-193 §4.4). */
export function shapeKey(shape: FadeShape): string {
  return shape.kind === "tool" ? "tool" : `${shape.path}:${shape.op}:${String(shape.value)}`;
}

/** A fade shape narrows to EXACTLY the grant scope it describes — never
 *  wider (ENG-193 §7 invariant: accept mints a grant matching ONLY the
 *  derived shape, tool-wide only when the shape itself was tool-wide). */
export function grantScopeFromShape(shape: FadeShape): GrantScope {
  return shape.kind === "tool"
    ? { kind: "tool" }
    : { kind: "constrained", constraints: [{ path: shape.path, op: shape.op, value: shape.value }] };
}

/** Deterministic proposal id: a hash of principal+tool+shape. */
export function computeProposalId(
  principal: { tenantId: string; subject: string },
  tool: string,
  shape: FadeShape,
): string {
  return fnv1a64(canonicalJson({ tenantId: principal.tenantId, subject: principal.subject, tool, shape }));
}
