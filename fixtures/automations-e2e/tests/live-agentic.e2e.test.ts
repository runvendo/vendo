/** Live leg (ANTHROPIC_API_KEY-gated): a real model behind the `@vendoai/agents`
 * away runner drives an away goal automation through the same guard-bound
 * registry the engine hands every run — 07 §4 with real reasoning, real fixture
 * tools, and record-bound authority only.
 *
 * The thinker is the SHIPPED default harness (`vendo()`) on the shipped runtime,
 * so this leg proves the whole away entry and not a test-only loop.
 */
import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { awayRunner } from "@vendoai/agents";
import { vendo } from "@vendoai/harnesses";
import { createStack, ownerCtx, resetFixture } from "../src/harness.js";
import { ADA, approve } from "../src/support.js";

const liveKey = process.env.ANTHROPIC_API_KEY;
const plausible = typeof liveKey === "string" && liveKey.startsWith("sk-");

interface RunRow {
  status: string;
  record: { steps: Array<{ tool: string; outcome: string }>; summary?: string };
}

describe.skipIf(!plausible)("live goal automation", () => {
  it("runs a real-model goal automation within captured grants", { timeout: 180_000 }, async ({ skip }) => {
    await resetFixture();
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    // The transport is the only place upstream weather is legible. The run row
    // cannot tell it from an engine defect: every model failure reaches it as
    // the one generic sentence, whatever threw (wire-error.ts:27, away.ts:597).
    // The LAST status Anthropic answered with can — a 429/5xx there is nothing
    // this engine can cause (our own bad payload is a 400), and reading the last
    // one means a failure the AI SDK retried into a success is not one.
    let lastUpstream = 0;
    const anthropic = createAnthropic({
      apiKey: liveKey,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        lastUpstream = response.status;
        return response;
      },
    });
    const stack = await createStack({
      runnerFrom: ({ guard, store }) =>
        awayRunner({
          harness: vendo(),
          models: { default: anthropic("claude-haiku-4-5") as LanguageModel },
          guard,
          store,
        }),
    });
    try {
      const ctx = ownerCtx(ADA.subject);
      const created = await stack.create({
        owner: ADA,
        when: { event: "live.agentic" },
        task: {
          kind: "goal",
          prompt: "Call the host_invoices_list tool exactly once and report how many invoices exist. Do not call any other tool.",
          budget: { maxToolCalls: 3 },
        },
        authoredBy: "chat",
      }, ctx);

      const enabled = await stack.automations.enable(created.id, ctx);
      // A goal task declares no tools, so capture proposes the whole away-safe
      // surface; the person grants only the read.
      const listCapture = enabled.missing.filter((request) => request.call.tool === "host_invoices_list");
      expect(listCapture).toHaveLength(1);
      await approve(stack, listCapture);

      const runIds = await stack.automations.emit("live.agentic", {}, ADA);
      expect(runIds).toHaveLength(1);

      // The test timeout is the only clock here: a poll that gave up earlier
      // would report a product bug when the model is merely slow.
      let row: RunRow | undefined;
      const deadline = Date.now() + 180_000;
      while (Date.now() <= deadline) {
        [row] = await stack.sql<RunRow>(
          "SELECT status, record FROM vendo_runs WHERE automation_id = $1",
          [created.id],
        );
        if (row !== undefined && row.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (row === undefined) throw new Error("run row never appeared");
      // An unavailable model leaves this UNPROVEN, never passed. Narrow on both
      // axes: a run that finished still asserts, and every other way to fail
      // still fails.
      skip(
        row.status !== "ok" && (lastUpstream === 429 || lastUpstream >= 500),
        `Anthropic answered ${lastUpstream}: the model was unavailable, so this run proves nothing`,
      );
      expect(row.status).toBe("ok");
      const listCalls = row.record.steps.filter((step) => step.tool === "host_invoices_list");
      expect(listCalls.length).toBeGreaterThanOrEqual(1);
      expect(listCalls[0]?.outcome).toBe("ok");
      expect(row.record.summary ?? "").not.toBe("");
    } finally {
      await stack.close();
    }
  });
});
