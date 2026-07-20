import path from "node:path";
import { describe, expect, it } from "vitest";
import { packOnce, runJourney, workspaceRoot } from "./journey.js";

/** Lane E full-journey e2e, env-gated live (the VENDO_LIVE_MCP pattern):
 *
 *   VENDO_LIVE_JOURNEY=1 ANTHROPIC_API_KEY=… pnpm --filter @vendoai-fixtures/existing-agents-e2e test
 *
 * Fresh AI SDK quickstart starter (derived from the shipped example by
 * stripping its `--- vendo` fences) → local Vendo pack + npm install → the
 * CURRENT `vendo init --yes` → the example's marked BYO diff applied
 * programmatically → `next dev` → one live Anthropic turn that lands
 * `vendo_create_app` → the generated app served over the wire. */
describe.skipIf(process.env.VENDO_LIVE_JOURNEY !== "1")("full journey: examples/ai-sdk-agent", () => {
  it("starter → vendo init → marked diff → boot → live turn → served app", async () => {
    expect(process.env.ANTHROPIC_API_KEY, "VENDO_LIVE_JOURNEY=1 needs ANTHROPIC_API_KEY").toBeTruthy();
    const artifactsDir = process.env.VENDO_JOURNEY_ARTIFACTS
      ?? path.join(workspaceRoot, "fixtures/existing-agents-e2e/.artifacts");
    const result = await runJourney({
      example: "ai-sdk-agent",
      port: Number(process.env.VENDO_JOURNEY_PORT ?? 4310),
      prompt: "Use vendo_create_app to make me a dashboard comparing the weather in Paris, London and Tokyo.",
      env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
      artifactsDir: path.join(artifactsDir, "ai-sdk-agent"),
      packed: await packOnce(),
    });
    // init wired the server route fresh (the journey's "server wiring" leg)…
    expect(result.initExitCode).toBe(0);
    expect(result.initWiredRoute).toBe(true);
    // …the marked diff landed the BYO surface…
    expect(result.appliedFiles).toContain("lib/vendo.ts");
    expect(result.appliedFiles).toContain(".vendo/tools.json");
    // …and the live turn drove a real app creation served over the wire.
    expect(result.appId).toMatch(/^app_/);
    expect(result.appSurface.kind).toBe("tree");
  });
});
