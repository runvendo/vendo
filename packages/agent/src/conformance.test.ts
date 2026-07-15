import { agentRunnerConformance, runConformance } from "@vendoai/core/conformance";
import { describe, expect, it } from "vitest";
import { createAgent } from "./index.js";
import {
  boundRegistry,
  ctx,
  scriptedModel,
  testGuard,
  textTurn,
  toolCallTurn,
} from "./test-helpers.js";

describe("core conformance — AgentRunner seam", () => {
  it("asRunner() passes agentRunnerConformance", async () => {
    const suite = agentRunnerConformance({
      makeRunner: async () => {
        const model = scriptedModel([
          toolCallTurn("conformance_echo", { ping: true }, "call_conformance"),
          textTurn("Echoed the conformance ping once.", "text_conformance"),
        ]);
        const guard = testGuard({});
        return createAgent({ model, tools: boundRegistry({}, guard), guard }).asRunner();
      },
      ctx: ctx({ venue: "automation", presence: "away", sessionId: "run_conformance" }),
    });
    const report = await runConformance(suite);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

it.skip("03-agent §3 clause (4) — catalog + theme summary is assembled for tree venues (Wave 5)", () => {
  // Intentionally visible and skipped until Wave 5 wires catalog/theme into
  // createAgent. Removing the skip before then would contradict the approved
  // staged contract implementation rather than close this Wave 2 test gap.
});
