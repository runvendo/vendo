/**
 * Deterministic grant matching (ENG-193 spec §4.3). Pure structural checks —
 * no model in the loop. Every uncertainty fails closed to "no match" (the
 * call then simply asks, which is always safe).
 */
import type { PermissionGrant } from "@flowlet/core";
import type { ToolDescriptor } from "../descriptor";
import { canonicalJson, fnv1a64, hashDescriptor } from "../automations/grants";

export function hashInput(input: unknown): string {
  return fnv1a64(canonicalJson(input));
}

export interface GrantMatchContext {
  tool: string;
  descriptor: ToolDescriptor;
  input: unknown;
  /** ISO timestamp for expiry checks. */
  now: string;
  /** Current session/task key for non-standing grants. */
  contextKey?: string;
}

function getByPath(obj: unknown, dotPath: string): unknown {
  let cursor: unknown = obj;
  for (const seg of dotPath.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

/** Glob with `*` wildcards only, anchored both ends, case-insensitive. */
function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : `\\${c}`));
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function constraintHolds(
  input: unknown,
  c: { path: string; op: "eq" | "lte" | "gte" | "matches"; value: string | number | boolean },
): boolean {
  const actual = getByPath(input, c.path);
  if (actual === undefined) return false; // fail closed
  switch (c.op) {
    case "eq":
      return actual === c.value;
    case "lte":
      return typeof actual === "number" && typeof c.value === "number" && actual <= c.value;
    case "gte":
      return typeof actual === "number" && typeof c.value === "number" && actual >= c.value;
    case "matches":
      return typeof actual === "string" && typeof c.value === "string" && globMatches(c.value, actual);
  }
}

export function grantMatches(grant: PermissionGrant, ctx: GrantMatchContext): boolean {
  if (grant.tool !== ctx.tool) return false;
  if (grant.revokedAt !== undefined) return false;
  if (grant.expiresAt !== undefined && grant.expiresAt <= ctx.now) return false;
  if (grant.descriptorHash !== hashDescriptor(ctx.descriptor)) return false;
  if (grant.duration !== "standing") {
    if (grant.contextKey === undefined || ctx.contextKey === undefined) return false;
    if (grant.contextKey !== ctx.contextKey) return false;
  }
  switch (grant.scope.kind) {
    case "tool":
      return true;
    case "exact":
      return grant.scope.inputHash === hashInput(ctx.input);
    case "constrained":
      return grant.scope.constraints.every((c) => constraintHolds(ctx.input, c));
  }
}
