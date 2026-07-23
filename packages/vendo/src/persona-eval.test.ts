import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { describe, expect, it } from "vitest";
import { distillPersona } from "./persona/index.js";
import { runPersonaReplay, seedSubject, type RunTurn, type SubjectFixture } from "./persona/eval.js";
import { GROUNDED_FIXTURES } from "./persona/eval-fixtures.js";

const repeat = (value: string, times: number): string[] => Array.from({ length: times }, () => value);

// Synthetic labeled subjects: each consistently reaches for one tool for a kind
// of ask, and the deciding tool is held out of the history. This is the shape of
// the real eval, at a scale that runs deterministically in CI.
const FIXTURES: SubjectFixture[] = [
  {
    subject: "eval_invoices",
    historyTools: [...repeat("host_invoices_list", 6), ...repeat("host_invoices_send", 2)],
    historyAsks: ["show unpaid invoices as a table", "the invoice table again", "table of overdue invoices"],
    holdout: [{ prompt: "what invoices are overdue", expectedTool: "host_invoices_list" }],
  },
  {
    subject: "eval_orders",
    historyTools: repeat("host_orders_list", 6),
    historyAsks: ["list my orders", "orders list please", "a list of recent orders"],
    holdout: [{ prompt: "which orders shipped", expectedTool: "host_orders_list" }],
  },
];

const AVAILABLE_TOOLS = ["host_invoices_list", "host_invoices_send", "host_orders_list", "host_customers_get"];
// Deliberately unrelated to the holdouts, so the stock agent misses.
const STOCK_FALLBACK = "host_customers_get";

const overlap = (tool: string, promptWords: Set<string>): number =>
  tool.split("_").filter((token) => promptWords.has(token)).length;

// Deterministic stand-in for a real agent turn. Without a persona it falls back
// blindly; with one, it prefers a persona-named tool that overlaps the prompt.
// This validates the harness and shows a persona can flip a decision; the
// model-in-the-loop number comes from swapping this for a real turn (a run that
// needs a model key, produced outside CI).
const oracle: RunTurn = async ({ prompt, persona }) => {
  if (persona === null) return STOCK_FALLBACK;
  const workflow = persona.facts.find((entry) => entry.kind === "workflow")?.text ?? "";
  const named = AVAILABLE_TOOLS.filter((tool) => workflow.includes(tool));
  const promptWords = new Set(prompt.toLowerCase().split(/\W+/).filter(Boolean));
  const ranked = [...named].sort((a, b) => overlap(b, promptWords) - overlap(a, promptWords));
  return ranked[0] ?? STOCK_FALLBACK;
};

describe("persona replay eval", () => {
  it("distills the deciding signal into each subject's persona", async () => {
    const store = memoryStoreAdapter();
    for (const fixture of FIXTURES) {
      await seedSubject(store, fixture);
      const persona = await distillPersona(store, fixture.subject);
      const workflow = persona.facts.find((entry) => entry.kind === "workflow")?.text ?? "";
      for (const decision of fixture.holdout) {
        // The information needed to reproduce the held-out choice is present in
        // the persona, which is the honest, model-free claim the harness rests on.
        expect(workflow).toContain(decision.expectedTool);
      }
    }
  });

  it("a persona-conditioned turn reproduces held-out decisions the stock turn misses", async () => {
    const store = memoryStoreAdapter();
    for (const fixture of FIXTURES) await seedSubject(store, fixture);

    const report = await runPersonaReplay(store, FIXTURES, oracle);

    expect(report.cases).toBe(2);
    expect(report.accuracyWith).toBeGreaterThan(report.accuracyWithout);
    expect(report.delta).toBeGreaterThan(0);
  });

  // The grounded fixtures are what the model-in-the-loop replay runs over. Their
  // held-out prompts are deliberately not lexically mappable to the deciding
  // tool, so the deterministic oracle cannot score them (only a real model can).
  // What holds model-free, and what CI asserts, is that the distilled persona
  // carries the deciding tool for every subject: the signal a real agent needs.
  it("distills the deciding tool into every grounded subject's persona", async () => {
    const store = memoryStoreAdapter();
    for (const fixture of GROUNDED_FIXTURES) {
      await seedSubject(store, fixture);
      const persona = await distillPersona(store, fixture.subject);
      const workflow = persona.facts.find((entry) => entry.kind === "workflow")?.text ?? "";
      for (const decision of fixture.holdout) {
        expect(workflow).toContain(decision.expectedTool);
      }
    }
  });
});
