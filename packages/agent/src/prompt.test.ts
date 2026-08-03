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

  it("resolves a product PROVIDER per call, so a cloud-backed brief is LIVE (cse lane 3)", async () => {
    const guard = testGuard({}, []);
    // (a) unset provider (returns undefined) = today's no-Product behavior.
    expect(await assembleSystemPrompt(guard, ctx(), { product: () => undefined }))
      .not.toContain("Product");
    // (b) an explicit string still folds in unchanged.
    expect(await assembleSystemPrompt(guard, ctx(), { product: "Maple, a neobank" }))
      .toContain("Product\nMaple, a neobank");
    // (c) a provider is re-read per call — a value change is reflected on the
    // NEXT turn with no recomposition (the live-brief contract).
    let brief = "Maple v1";
    const system = { product: () => brief };
    expect(await assembleSystemPrompt(guard, ctx(), system)).toContain("Product\nMaple v1");
    brief = "Maple v2";
    expect(await assembleSystemPrompt(guard, ctx(), system)).toContain("Product\nMaple v2");
    // A blank provider result is dropped like a blank string.
    expect(await assembleSystemPrompt(guard, ctx(), { product: () => "   " })).not.toContain("Product");
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

  it("AGENT-1: injects the catalog+theme summary after directions, before instructions, when the venue renders trees", async () => {
    const guard = testGuard({}, ["Never disclose balances"]);
    const summary = "Host components:\n- InvoiceTable: renders invoice line items";
    for (const venue of ["chat", "app"] as const) {
      const prompt = await assembleSystemPrompt(guard, ctx({ venue }), {
        product: "Maple, a neobank",
        catalog: summary,
        instructions: "Prefer concise answers.",
      });
      expect(prompt).toContain(summary);
      expect(prompt.indexOf("Directions")).toBeLessThan(prompt.indexOf("InvoiceTable"));
      expect(prompt.indexOf("InvoiceTable")).toBeLessThan(prompt.indexOf("Prefer concise answers."));
    }
  });

  it("knowledge k8: injects the knowledge index after the catalog, before instructions, on tree venues", async () => {
    const guard = testGuard({}, ["Never disclose balances"]);
    const index = "Knowledge\nThe host has a product knowledge base of 3 documents.";
    for (const venue of ["chat", "app"] as const) {
      const prompt = await assembleSystemPrompt(guard, ctx({ venue }), {
        catalog: "Host components:\n- InvoiceTable: renders invoice line items",
        knowledge: index,
        instructions: "Prefer concise answers.",
      });
      expect(prompt).toContain(index);
      expect(prompt.indexOf("InvoiceTable")).toBeLessThan(prompt.indexOf("Knowledge\n"));
      expect(prompt.indexOf("Knowledge\n")).toBeLessThan(prompt.indexOf("Prefer concise answers."));
    }
  });

  it("knowledge k8: omits the knowledge index for automation and MCP venues — descriptors carry the guidance there", async () => {
    for (const venue of ["automation", "mcp"] as const) {
      const prompt = await assembleSystemPrompt(testGuard({}, []), ctx({ venue }), {
        knowledge: "Knowledge\nThe host has a product knowledge base of 3 documents.",
        instructions: "Only this.",
      });
      expect(prompt).not.toContain("knowledge base");
      expect(prompt.endsWith("Only this.")).toBe(true);
    }
  });

  it("knowledge k8 P0: the ONLY knowledge content in any venue's prompt is the resolver's bytes — internal source names filtered upstream can never reappear", async () => {
    // The umbrella's assembler filters internal sources out of the resolver
    // output (knowledge-prompt.ts, unit-tested there). This sweep closes the
    // loop at the prompt layer for ALL FOUR venues: tree venues carry the
    // resolver bytes verbatim and nothing else knowledge-shaped; the other
    // venues carry no knowledge block at all.
    const guard = testGuard({}, []);
    const filtered = "Knowledge\n4 documents — sources: help-center (docs).";
    for (const venue of ["chat", "app"] as const) {
      const prompt = await assembleSystemPrompt(guard, ctx({ venue }), { knowledge: filtered });
      expect(prompt).toContain(filtered);
      expect(prompt).not.toContain("secret-fraud-runbooks");
    }
    for (const venue of ["automation", "mcp"] as const) {
      const prompt = await assembleSystemPrompt(guard, ctx({ venue }), { knowledge: filtered });
      expect(prompt).not.toContain("Knowledge\n");
      expect(prompt).not.toContain("help-center");
    }
  });

  it("knowledge k8: awaits a knowledge RESOLVER and drops an undefined or blank resolution", async () => {
    const guard = testGuard({}, []);
    // The umbrella's boot-locked resolver is async — the first turn awaits it.
    expect(await assembleSystemPrompt(guard, ctx(), { knowledge: async () => "Knowledge\n3 documents." }))
      .toContain("Knowledge\n3 documents.");
    expect(await assembleSystemPrompt(guard, ctx(), { knowledge: () => undefined, instructions: "Only this." }))
      .toMatch(/Only this\.$/);
    expect(await assembleSystemPrompt(guard, ctx(), { knowledge: async () => "   ", instructions: "Only this." }))
      .toMatch(/Only this\.$/);
  });

  it("AGENT-1: omits the catalog summary for venues that cannot render trees", async () => {
    const summary = "Host components:\n- InvoiceTable: renders invoice line items";
    for (const venue of ["automation", "mcp"] as const) {
      const prompt = await assembleSystemPrompt(testGuard({}, []), ctx({ venue }), {
        catalog: summary,
        instructions: "Only this.",
      });
      expect(prompt).not.toContain("InvoiceTable");
      expect(prompt.endsWith("Only this.")).toBe(true);
    }
  });
});

/** Demo-refresh 2026-07-23: presentation discipline — rendered views own the
 * data; the reply around them stays out of the way. Venue-gated with the
 * catalog (only surfaces that render trees need it). */
describe("presentation discipline", () => {
  it("rides tree venues (chat/app)", async () => {
    const prompt = await assembleSystemPrompt(testGuard({}, []), ctx());
    expect(prompt).toContain("Presentation");
    expect(prompt).toContain("never restate its data");
    const appPrompt = await assembleSystemPrompt(testGuard({}, []), ctx({ venue: "app" }));
    expect(appPrompt).toContain("Presentation");
  });

  it("stays out of automation and MCP venues", async () => {
    for (const venue of ["automation", "mcp"] as const) {
      const prompt = await assembleSystemPrompt(testGuard({}, []), ctx({ venue }));
      expect(prompt).not.toContain("Presentation");
    }
  });
});

/** Discovery-discipline 2026-07-25 (criterion 12): tool discovery gets a hard
 * budget so a connector catalog can never become an agent side-quest. Rides
 * only when tool search is configured — without the meta-tool there is
 * nothing to budget. */
describe("discovery budget", () => {
  it("rides the prompt when tool search is enabled", async () => {
    const prompt = await assembleSystemPrompt(testGuard({}, []), ctx(), undefined, false, true);
    expect(prompt).toContain("Discovery budget");
    expect(prompt).toContain("at most 2");
    expect(prompt).toMatch(/unconnected/i);
  });

  it("stays out when tool search is off", async () => {
    const prompt = await assembleSystemPrompt(testGuard({}, []), ctx(), undefined, false, false);
    expect(prompt).not.toContain("Discovery budget");
    const defaulted = await assembleSystemPrompt(testGuard({}, []), ctx());
    expect(defaulted).not.toContain("Discovery budget");
  });
});

describe("§3's consumer-voice register rides the operating prompt", () => {
  // Wave-1 live proof E1-5: an honest refusal named `host_transferMoney` in a
  // code span to an end user. The model wrote it, and nothing in its prompt told
  // it not to — the register the spec calls mandatory ("every skill and prompt
  // carries the register") was in no prompt at all.
  it("forbids identifiers in what the user reads and names the title as the vocabulary", async () => {
    const prompt = await assembleSystemPrompt(testGuard({}, []), ctx());
    expect(prompt).toMatch(/never .*identifier|identifier.*never/i);
    expect(prompt).toContain("title");
  });
});
