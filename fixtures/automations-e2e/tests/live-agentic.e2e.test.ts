/** Live leg (ANTHROPIC_API_KEY-gated): a real model behind the `@vendoai/agents`
 * away runner drives an away agentic automation through the same guard-bound
 * registry the engine hands every run — 07 §4 agentic with real reasoning, real
 * fixture tools, and app-bound authority only.
 *
 * The thinker is the SHIPPED default harness (`vendo()`) on the shipped runtime,
 * so this leg proves the whole away entry and not a test-only loop.
 */
import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { awayRunner } from "@vendoai/agents";
import { vendo } from "@vendoai/harnesses";
import { automationDoc, createStack, ownerCtx, resetFixture } from "../src/harness.js";
import { ADA, approve } from "../src/support.js";

const liveKey = process.env.ANTHROPIC_API_KEY;
const plausible = typeof liveKey === "string" && liveKey.startsWith("sk-");

describe.skipIf(!plausible)("live agentic automation", () => {
  it("runs a real-model agentic automation within captured grants", { timeout: 180_000 }, async () => {
    await resetFixture();
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const anthropic = createAnthropic({ apiKey: liveKey });
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
      const appId = "app_live_agentic";
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        trigger: {
          on: { kind: "host-event", event: "live.agentic" },
          run: {
            kind: "agentic",
            prompt: "Call the host_invoices_list tool exactly once and report how many invoices exist. Do not call any other tool.",
            budget: { maxToolCalls: 3 },
          },
        },
      }));

      const enabled = await stack.automations.enable(appId, "main", ownerCtx(ADA.subject, appId));
      // Agentic capture proposes the full bound surface; grant only the read.
      const listCapture = enabled.missing.filter((request) => request.call.tool === "host_invoices_list");
      expect(listCapture).toHaveLength(1);
      await approve(stack, listCapture);

      const runIds = await stack.automations.emit("live.agentic", {}, ADA);
      expect(runIds).toHaveLength(1);
      const runId = runIds[0] as string;

      let row: { status: string; record: { steps: Array<{ tool: string; outcome: string }>; summary?: string } } | undefined;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const rows = await stack.sql<{ status: string; record: typeof row extends undefined ? never : NonNullable<typeof row>["record"] }>(
          "SELECT status, record FROM vendo_runs WHERE id = $1",
          [runId],
        );
        row = rows[0] as typeof row;
        if (row !== undefined && row.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (row === undefined) throw new Error("run row never appeared");
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
