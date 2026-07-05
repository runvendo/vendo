/**
 * Shared fixture data for the kill-the-server persistence drill
 * (docs/superpowers/plans/2026-07-04-automations-oss-persistence.md Task 19).
 * Imported by both drill-persistence.mjs (the orchestrator) and
 * drill-persistence-store.mjs (the offline seed/verify child process) so the
 * two never drift.
 */

/** Scope for every seed — matches WORLD_SCOPE in
 *  packages/vendo-next/src/guard.ts, and the drill principal demo-bank's
 *  route.ts resolves to under VENDO_DRILL=1. */
export const SCOPE = { tenantId: "vendo-embedded", subject: "vendo-default-user" };

/**
 * MUST byte-for-byte match apps/demo-bank/src/app/api/vendo/[...path]/route.ts's
 * DRILL_ECHO_DESCRIPTOR. computeGrant hashes over this object; a mismatch
 * makes the grant invalid and the step would pause for approval instead of
 * running unattended (the drill's core assertion would fail).
 */
export const DRILL_ECHO_DESCRIPTOR = {
  name: "drill_echo",
  source: "caller",
  annotations: {},
  hasExecute: true,
  kind: "function",
};

/** A ~1-minute cron trigger with a single deterministic tool step, per Task 19. */
export const AUTOMATION_SPEC_INPUT = {
  dslVersion: 1,
  name: "Drill echo",
  description: "Kill-the-server persistence drill fixture — fires drill_echo every minute.",
  prompt: "run drill_echo every minute",
  trigger: { type: "schedule", cron: "* * * * *", timezone: "UTC" },
  execution: {
    mode: "steps",
    steps: [{ id: "echo", type: "tool", tool: "drill_echo", input: {} }],
  },
};

export const VENDO_ID = "drill-vendo-1";

export const THREAD_ID = "drill-thread-1";

export const THREAD_MESSAGES = [
  { id: "drill-msg-1", role: "user", parts: [{ type: "text", text: "seed message one" }] },
  { id: "drill-msg-2", role: "assistant", parts: [{ type: "text", text: "seed message two" }] },
];

/** A minimal PolicyContext-shaped object — canonicalKey() only reads
 *  principal.userId, toolName, and input (see
 *  packages/vendo-runtime/src/policy/remember.ts). */
export const DECISION_CONTEXT = {
  principal: { userId: SCOPE.subject },
  toolName: "drill_decision_tool",
  input: { probe: "drill" },
};

/** Must match DECISION_POLICY_VERSION in packages/vendo-next/src/handler.ts. */
export const DECISION_POLICY_VERSION = "v1";
