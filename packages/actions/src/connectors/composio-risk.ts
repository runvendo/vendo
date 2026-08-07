import type { RiskLabel } from "@vendoai/core";

/** 04-actions §3 — Composio risk resolution from UPSTREAM FACTS ONLY: the
 * toolkit's own `destructiveHint` / `readOnlyHint` tags, which the provider
 * asserts about its own tool. A slug is a name, and names grade nothing
 * (risk-grading redesign D1) — an untagged tool is `ungraded` and the guard
 * asks about it until the judge or a human grades it. `overrides.json` still
 * wins downstream via the registry's mergeOverride. */
export function composioToolRisk(tags?: string[]): RiskLabel {
  // Destructive beats a stale read-only hint.
  if (tags?.includes("destructiveHint") === true) return "destructive";
  if (tags?.includes("readOnlyHint") === true) return "read";
  return "ungraded";
}
