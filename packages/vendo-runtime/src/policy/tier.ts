/**
 * Danger tiers (ENG-193 spec §4.1), derived deterministically from the tool
 * descriptor annotations. `critical` is checked BEFORE any grant/fade/judge
 * suppression — grantPolicy refuses to suppress it by type, which is the
 * "money always needs you" invariant.
 *
 * Unknown-annotation tools (no informative hints) land in `act` but are
 * flagged unverified (Yousef ruling 2026-07-03): usable and grantable, with
 * the flag surfaced on cards and the Trust screen.
 */
import type { ToolDescriptor } from "../descriptor.js";

export type DangerTier = "read" | "act" | "critical";

export function dangerTier(descriptor: ToolDescriptor): DangerTier {
  const a = descriptor.annotations;
  if (a.destructiveHint === true) return "critical";
  if (a.readOnlyHint === true) return "read";
  return "act";
}

/** True when the tool carries no informative safety hints at all. */
export function isUnverified(descriptor: ToolDescriptor): boolean {
  const a = descriptor.annotations;
  return (
    a.readOnlyHint === undefined &&
    a.destructiveHint === undefined &&
    a.openWorldHint === undefined
  );
}

/** Structured verdict for consent surfaces (spec §4.1). Derived, not stored. */
export interface PolicyVerdict {
  outcome: "allow" | "ask" | "deny";
  tier: DangerTier;
  suppressible: boolean;
  unverified: boolean;
}
