import { describe, expect, it } from "vitest";
import type { ExtractionDraft } from "@vendoai/vendo/extract";
import { scoreAiExtraction, type AiScoredStaticTool } from "./score.js";
import type { RepoAiExpectations } from "./expectations.js";

/** Canned static extraction facts for a small invoicing app. */
const staticTools: AiScoredStaticTool[] = [
  {
    name: "host_api_invoices_get",
    description: "GET /api/invoices",
    risk: "read",
    identity: "GET\t/api/invoices",
  },
  {
    name: "host_api_invoices_post",
    description: "POST /api/invoices",
    risk: "write",
    identity: "POST\t/api/invoices",
  },
  {
    name: "host_api_invoices_id_delete",
    description: "DELETE /api/invoices/{id}",
    risk: "write",
    identity: "DELETE\t/api/invoices/{id}",
  },
  {
    name: "host_api_webhooks_unclassified",
    description: "Route /api/webhooks could not be classified",
    risk: "destructive",
    disabled: true,
    identity: "POST\t/api/webhooks",
  },
];

const expected: RepoAiExpectations = {
  version: 1,
  tools: [
    { name: "listInvoices", method: "GET", path: "/api/invoices", risk: "read" },
    { name: "createInvoice", method: "POST", path: "/api/invoices", risk: "write" },
    { name: "deleteInvoice", method: "DELETE", path: "/api/invoices/{id}", risk: "destructive", critical: true },
    { name: "webhook", method: "POST", path: "/api/webhooks", risk: "write" },
  ],
};

/** A draft that gets everything right; overrides mirror what applyDraft
 * produces for it on a clean root. */
const perfectDraft: ExtractionDraft = {
  brief: "An invoicing product for freelancers: list and create invoices, delete drafts, and receive payment webhooks. The agent helps users find, create, and clean up invoices safely.",
  tools: [
    { name: "host_api_invoices_get", description: "List the current user's invoices with status and totals." },
    { name: "host_api_invoices_post", description: "Create a new invoice draft for a customer." },
    {
      name: "host_api_invoices_id_delete",
      description: "Permanently delete an invoice by id; this cannot be undone.",
      risk: "destructive",
      critical: true,
    },
    {
      name: "host_api_webhooks_unclassified",
      description: "Receive payment-provider webhook events and update invoice state.",
      disabled: false,
      risk: "write",
      reasoning: "Handler only records provider events; it is an ordinary write.",
    },
  ],
};

const perfectOverrides = {
  host_api_invoices_get: { description: "List the current user's invoices with status and totals." },
  host_api_invoices_post: { description: "Create a new invoice draft for a customer." },
  host_api_invoices_id_delete: {
    description: "Permanently delete an invoice by id; this cannot be undone.",
    risk: "destructive" as const,
    critical: true,
  },
  host_api_webhooks_unclassified: {
    description: "Receive payment-provider webhook events and update invoice state.",
    disabled: false,
    risk: "write" as const,
  },
};

function check(result: ReturnType<typeof scoreAiExtraction>, id: string) {
  const found = result.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing check ${id} in ${result.checks.map((c) => c.id).join(", ")}`);
  return found;
}

describe("scoreAiExtraction", () => {
  it("gives a perfect draft a perfect score", () => {
    const result = scoreAiExtraction({
      staticTools,
      draft: perfectDraft,
      overrides: perfectOverrides,
      expected,
    });

    expect(result.hardFailure).toBe(false);
    expect(result.score.value).toBe(1);
    for (const entry of result.checks) {
      expect(entry.pass, `${entry.id}: ${entry.detail}`).toBe(true);
    }
    expect(Object.keys(result.dimensions).sort()).toEqual([
      "brief", "descriptions", "draft", "guards", "risk", "wake",
    ]);
    expect(result.dimensions.descriptions).toEqual({ passed: 4, total: 4, value: 1 });
  });

  it("hard-fails an unparseable draft but keeps stable denominators", () => {
    const result = scoreAiExtraction({
      staticTools,
      draft: null,
      draftError: "no JSON object found in the agent's output",
      overrides: {},
      expected,
    });

    expect(result.hardFailure).toBe(true);
    expect(check(result, "ai.draft.valid").pass).toBe(false);
    expect(check(result, "ai.draft.valid").detail).toContain("no JSON object");
    expect(result.score.value).toBe(0);

    const good = scoreAiExtraction({ staticTools, draft: perfectDraft, overrides: perfectOverrides, expected });
    expect(result.score.total).toBe(good.score.total);
  });

  it("counts hallucinated tool names and malformed wakes as model-error refusals", () => {
    const draft: ExtractionDraft = {
      ...perfectDraft,
      tools: [
        ...perfectDraft.tools.slice(0, 3),
        { name: "host_made_up_tool", description: "A tool that does not exist in the static set at all." },
        // Wake attempt without reasoning/risk: refused by the guards.
        { name: "host_api_webhooks_unclassified", description: "Receive payment webhook events from the provider.", disabled: false },
      ],
    };
    const overrides = {
      host_api_invoices_get: perfectOverrides.host_api_invoices_get,
      host_api_invoices_post: perfectOverrides.host_api_invoices_post,
      host_api_invoices_id_delete: perfectOverrides.host_api_invoices_id_delete,
      host_api_webhooks_unclassified: { description: "Receive payment webhook events from the provider." },
    };

    const result = scoreAiExtraction({ staticTools, draft, overrides, expected });
    const guard = check(result, "ai.guards.clean");
    expect(guard.pass).toBe(false);
    expect(guard.detail).toContain("2/5");
    // The webhook tool was not woken, so wake correctness drops too.
    expect(check(result, "ai.wake.correct").pass).toBe(false);
  });

  it("detects false refusals: a guard-blocked downgrade the labels agree with", () => {
    // Static extraction over-graded the GET as write; the model correctly says
    // read; the guard refuses the downgrade by design. The labels agree with
    // the model, so this surfaces as a false refusal without failing the run.
    const overGraded = staticTools.map((tool) =>
      tool.name === "host_api_invoices_get" ? { ...tool, risk: "write" as const } : tool);
    const draft: ExtractionDraft = {
      ...perfectDraft,
      tools: perfectDraft.tools.map((tool) =>
        tool.name === "host_api_invoices_get" ? { ...tool, risk: "read" as const } : tool),
    };

    const result = scoreAiExtraction({ staticTools: overGraded, draft, overrides: perfectOverrides, expected });
    const falseRefusals = check(result, "ai.guards.false-refusals");
    expect(falseRefusals.pass).toBe(true);
    expect(falseRefusals.detail).toContain("1 false refusal");
    expect(falseRefusals.detail).toContain("host_api_invoices_get");
    // The effective risk stays wrong-high, so risk accuracy takes the hit.
    expect(check(result, "ai.risk.accuracy").pass).toBe(false);
  });

  it("scores mechanical, too-short, and resource-less descriptions down", () => {
    const draft: ExtractionDraft = {
      ...perfectDraft,
      tools: [
        // Mechanical: equals the path-derived static default.
        { name: "host_api_invoices_get", description: "GET /api/invoices" },
        // Too short, and never mentions invoices.
        { name: "host_api_invoices_post", description: "Creates stuff." },
        // The DELETE tool is never described: coverage drops.
      ],
    };
    const overrides = {
      host_api_invoices_post: { description: "Creates stuff." },
    };

    const result = scoreAiExtraction({ staticTools, draft, overrides, expected });
    expect(check(result, "ai.descriptions.non-mechanical").pass).toBe(false);
    expect(check(result, "ai.descriptions.length").pass).toBe(false);
    expect(check(result, "ai.descriptions.mentions-resource").pass).toBe(false);
    expect(check(result, "ai.descriptions.coverage").pass).toBe(false);
    // Wake was skipped entirely: the disabled webhook tool stays asleep and is
    // expected woken, so the wake check fails without an explicit wake label.
    expect(check(result, "ai.wake.correct").pass).toBe(false);
  });

  it("scores risk accuracy and critical marks against the labels", () => {
    // Model never raises the DELETE: effective risk stays write, no critical.
    const draft: ExtractionDraft = {
      ...perfectDraft,
      tools: perfectDraft.tools.map((tool) =>
        tool.name === "host_api_invoices_id_delete"
          ? { name: tool.name, description: tool.description }
          : tool),
    };
    const overrides = {
      ...perfectOverrides,
      host_api_invoices_id_delete: { description: perfectOverrides.host_api_invoices_id_delete.description },
    };

    const result = scoreAiExtraction({ staticTools, draft, overrides, expected });
    const risk = check(result, "ai.risk.accuracy");
    expect(risk.pass).toBe(false);
    expect(risk.detail).toContain("3/4");
    expect(check(result, "ai.risk.critical").pass).toBe(false);
  });

  it("respects wake:false labels — waking a pinned-asleep tool is wrong", () => {
    const pinned: RepoAiExpectations = {
      version: 1,
      tools: [
        ...expected.tools.slice(0, 3),
        { name: "webhook", method: "POST", path: "/api/webhooks", risk: "write", wake: false },
      ],
    };

    const result = scoreAiExtraction({ staticTools, draft: perfectDraft, overrides: perfectOverrides, expected: pinned });
    const wake = check(result, "ai.wake.correct");
    expect(wake.pass).toBe(false);
    expect(wake.detail).toContain("host_api_webhooks_unclassified");
  });

  it("skips label-driven checks gracefully without expectations", () => {
    const result = scoreAiExtraction({ staticTools, draft: perfectDraft, overrides: perfectOverrides, expected: null });

    expect(result.checks.some((entry) => entry.id === "ai.risk.accuracy")).toBe(false);
    expect(result.checks.some((entry) => entry.id === "ai.wake.correct")).toBe(false);
    expect(check(result, "ai.draft.valid").pass).toBe(true);
    expect(result.score.value).toBe(1);
  });

  it("flags an out-of-bounds brief", () => {
    const result = scoreAiExtraction({
      staticTools,
      draft: { ...perfectDraft, brief: "Too short." },
      overrides: perfectOverrides,
      expected,
    });
    expect(check(result, "ai.brief.drafted").pass).toBe(false);
  });
});
