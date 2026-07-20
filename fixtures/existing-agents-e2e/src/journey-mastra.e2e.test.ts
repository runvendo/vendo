import path from "node:path";
import { describe, expect, it } from "vitest";
import { packOnce, runJourney, workspaceRoot } from "./journey.js";

/** Lane E full-journey e2e for the Mastra example, env-gated live:
 *
 *   VENDO_LIVE_JOURNEY=1 ANTHROPIC_API_KEY=… OPENAI_API_KEY=… \
 *     pnpm --filter @vendoai-fixtures/existing-agents-e2e test
 *
 * The Mastra loop keeps its own model (the starter's openai/gpt-4.1-mini —
 * hence OPENAI_API_KEY); Vendo's generation seam resolves ANTHROPIC_API_KEY
 * from the env ladder. Same journey: starter → `vendo init --yes` → marked
 * diff → boot → live turn → served app. */
describe.skipIf(process.env.VENDO_LIVE_JOURNEY !== "1")("full journey: examples/mastra-agent", () => {
  it("starter → vendo init → marked diff → boot → live turn → served app", async () => {
    expect(process.env.ANTHROPIC_API_KEY, "VENDO_LIVE_JOURNEY=1 needs ANTHROPIC_API_KEY").toBeTruthy();
    expect(process.env.OPENAI_API_KEY, "the Mastra starter's own model needs OPENAI_API_KEY").toBeTruthy();
    const artifactsDir = process.env.VENDO_JOURNEY_ARTIFACTS
      ?? path.join(workspaceRoot, "fixtures/existing-agents-e2e/.artifacts");
    const result = await runJourney({
      example: "mastra-agent",
      port: Number(process.env.VENDO_JOURNEY_PORT ?? 4311),
      prompt: "Use vendo_create_app to make me a dashboard comparing the weather in Paris, London and Tokyo.",
      env: {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      },
      artifactsDir: path.join(artifactsDir, "mastra-agent"),
      packed: await packOnce(),
    });
    expect(result.initExitCode).toBe(0);
    expect(result.initWiredRoute).toBe(true);
    expect(result.appliedFiles).toContain("src/lib/vendo.ts");
    expect(result.appliedFiles).toContain(".vendo/tools.json");
    expect(result.appId).toMatch(/^app_/);
    expect(result.appSurface.kind).toBe("tree");
  });
});
