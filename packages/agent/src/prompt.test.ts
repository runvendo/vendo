import { describe, expect, it } from "vitest";
import { assembleSystemPrompt } from "./prompt.js";
import { ctx, testGuard } from "./test-helpers.js";

/** 03-agent §3 — the system prompt is assembled from the operating prompt plus
 * mandatory company directions (fail-closed) and optional product/instructions. */
describe("assembleSystemPrompt", () => {
  it("returns just the operating prompt when there is no product, directions, or instructions", async () => {
    const prompt = await assembleSystemPrompt(testGuard({}, []), ctx());
    expect(prompt.startsWith("You are Vendo's agent.")).toBe(true);
    expect(prompt).not.toContain("Product");
    expect(prompt).not.toContain("Directions");
  });

  it("folds in product, directions (bulleted), and instructions in section order", async () => {
    const guard = testGuard({}, ["Never disclose balances", "Escalate wires"]);
    const prompt = await assembleSystemPrompt(guard, ctx(), {
      product: "Maple, a neobank",
      instructions: "Prefer concise answers.",
    });
    expect(prompt).toContain("Product\nMaple, a neobank");
    expect(prompt).toContain("Directions\n- Never disclose balances\n- Escalate wires");
    expect(prompt).toContain("Prefer concise answers.");
    // Order: operating prompt, then Product, then Directions, then instructions.
    expect(prompt.indexOf("Product")).toBeLessThan(prompt.indexOf("Directions"));
    expect(prompt.indexOf("Directions")).toBeLessThan(prompt.indexOf("Prefer concise answers."));
  });

  it("trims directions and drops blank ones; omits a whitespace-only product", async () => {
    const guard = testGuard({}, ["  Trim me  ", "   ", ""]);
    const prompt = await assembleSystemPrompt(guard, ctx(), { product: "   " });
    expect(prompt).toContain("Directions\n- Trim me");
    expect(prompt).not.toContain("- \n");
    expect(prompt).not.toContain("Product");
  });

  it("omits the Directions section entirely when the guard returns none", async () => {
    const prompt = await assembleSystemPrompt(testGuard({}, []), ctx(), { instructions: "Only this." });
    expect(prompt).not.toContain("Directions");
    expect(prompt.endsWith("Only this.")).toBe(true);
  });
});
