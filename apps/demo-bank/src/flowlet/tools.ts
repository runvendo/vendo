/**
 * The demo agent's in-process tools, assembled per request.
 *
 * Phase 0 ships none. Later beats add tools here:
 *  - Beat 1: a transaction reader so the agent can fill the TimeOfDayClock.
 *  - Beat 3: a rule-setter so the agent can store the natural-language guardrail.
 */
import type { ToolSet } from "ai";

export function demoTools(): ToolSet {
  return {};
}
