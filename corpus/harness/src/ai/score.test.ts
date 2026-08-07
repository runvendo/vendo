import { describe, expect, it } from "vitest";
import { bindingIdentity, type ExtractedTool } from "@vendoai/actions";
import { scoreAiJudgments, type AiScoredJudgment, type AiScoredStaticTool } from "./score.js";
import type { RepoAiExpectations } from "./expectations.js";

/** Canned `.vendo/tools.json` facts for a small invoicing app, in the shape
 * `applyJudgment` needs (full ExtractedTool, not a reduction). */
function staticTool(
  name: string,
  method: "GET" | "POST" | "DELETE" | "PATCH",
  routePath: string,
  extra: Partial<ExtractedTool> = {},
): AiScoredStaticTool {
  const tool: ExtractedTool = {
    name,
    description: `${method} ${routePath}`,
    inputSchema: { type: "object" },
    risk: "read",
    binding: { kind: "route", method, path: routePath, argsIn: method === "GET" ? "query" : "body" },
    ...extra,
  };
  return { tool, identity: `${method}\t${routePath}` };
}

const staticTools: AiScoredStaticTool[] = [
  staticTool("host_api_invoices_get", "GET", "/api/invoices", { risk: "read" }),
  staticTool("host_api_invoices_post", "POST", "/api/invoices", { risk: "write" }),
  staticTool("host_api_invoices_id_delete", "DELETE", "/api/invoices/{id}", { risk: "write" }),
  staticTool("host_api_webhooks_unclassified", "POST", "/api/webhooks", {
    risk: "destructive",
    disabled: true,
    description: "Route /api/webhooks could not be classified",
  }),
];

const expected: RepoAiExpectations = {
  version: 1,
  tools: [
    { name: "listInvoices", method: "GET", path: "/api/invoices", risk: "read" },
    { name: "createInvoice", method: "POST", path: "/api/invoices", risk: "write" },
    { name: "deleteInvoice", method: "DELETE", path: "/api/invoices/{id}", risk: "destructive", confirmEach: true },
    { name: "webhook", method: "POST", path: "/api/webhooks", risk: "write" },
  ],
};

const identityOf = (name: string): string =>
  bindingIdentity(staticTools.find((entry) => entry.tool.name === name)!.tool.binding);

function judgment(name: string, fields: AiScoredJudgment["fields"], evidence = "const rows = await db.query(...)"): AiScoredJudgment {
  return { binding: identityOf(name), fields, evidence };
}

/** Everything the labels ask for, landed: the DELETE hardened to destructive +
 * confirmEach, the unclassifiable webhook woken as an ordinary write. */
const perfectJudgments: Record<string, AiScoredJudgment> = {
  host_api_invoices_get: judgment("host_api_invoices_get", {
    description: "List the current user's invoices with status and totals.",
  }),
  host_api_invoices_post: judgment("host_api_invoices_post", {
    description: "Create a new invoice draft for a customer.",
  }),
  host_api_invoices_id_delete: judgment("host_api_invoices_id_delete", {
    description: "Permanently delete an invoice by id; this cannot be undone.",
    risk: "destructive",
    confirmEach: true,
  }),
  host_api_webhooks_unclassified: judgment("host_api_webhooks_unclassified", {
    description: "Receive payment-provider webhook events and update invoice state.",
    disabled: false,
    risk: "write",
  }),
};

function check(result: ReturnType<typeof scoreAiJudgments>, id: string) {
  const found = result.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing check ${id} in ${result.checks.map((c) => c.id).join(", ")}`);
  return found;
}

describe("scoreAiJudgments", () => {
  it("gives a judgments file that matches every label a perfect score", () => {
    const result = scoreAiJudgments({ staticTools, judgments: perfectJudgments, expected });

    expect(result.hardFailure).toBe(false);
    expect(result.score.value).toBe(1);
    for (const entry of result.checks) {
      expect(entry.pass, `${entry.id}: ${entry.detail}`).toBe(true);
    }
    expect(Object.keys(result.dimensions).sort()).toEqual([
      "confirmEach", "descriptions", "evidence", "pass", "risk", "wake",
    ]);
  });

  it("hard-fails a pass that produced no judgments but keeps stable denominators", () => {
    const result = scoreAiJudgments({
      staticTools,
      judgments: null,
      passError: "judgment output unparseable — skipped",
      expected,
    });

    expect(result.hardFailure).toBe(true);
    expect(check(result, "ai.pass.judged").pass).toBe(false);
    expect(check(result, "ai.pass.judged").detail).toContain("unparseable");
    expect(result.score.value).toBe(0);

    const good = scoreAiJudgments({ staticTools, judgments: perfectJudgments, expected });
    expect(result.score.total).toBe(good.score.total);
  });

  it("computes the effective tool as tools.json ⊕ the applied judgment", () => {
    // Only the DELETE hardening lands; nothing else is judged.
    const result = scoreAiJudgments({
      staticTools,
      judgments: { host_api_invoices_id_delete: perfectJudgments.host_api_invoices_id_delete! },
      expected,
    });

    const risk = check(result, "ai.risk.accuracy");
    // GET read ✓, POST write ✓, DELETE destructive ✓ — the asleep webhook is not
    // risk-judgeable, so it sits in the wake dimension instead.
    expect(risk.detail).toContain("3/3");
    expect(risk.pass).toBe(true);
  });

  it("ignores a judgment whose binding moved, so its grade never lands", () => {
    const rebound: Record<string, AiScoredJudgment> = {
      ...perfectJudgments,
      host_api_invoices_id_delete: {
        ...perfectJudgments.host_api_invoices_id_delete!,
        binding: "DELETE /api/invoices/{}/archive",
      },
    };

    const result = scoreAiJudgments({ staticTools, judgments: rebound, expected });
    const risk = check(result, "ai.risk.accuracy");
    expect(risk.pass).toBe(false);
    expect(risk.detail).toContain("host_api_invoices_id_delete");
  });

  describe("risk accuracy scores both directions", () => {
    it("credits an upheld downgrade the same as an upheld hardening", () => {
      // Static extraction over-graded the GET as destructive; the labels say
      // read. Lowering risk is a LOOSENING, so it only reaches `fields` after a
      // human approved it — which the matrix does with an always-yes confirm.
      const overGraded = staticTools.map((entry) =>
        entry.tool.name === "host_api_invoices_get"
          ? { ...entry, tool: { ...entry.tool, risk: "destructive" as const } }
          : entry);
      const judgments = {
        ...perfectJudgments,
        host_api_invoices_get: judgment("host_api_invoices_get", {
          description: "List the current user's invoices with status and totals.",
          risk: "read",
        }),
      };

      const result = scoreAiJudgments({ staticTools: overGraded, judgments, expected });
      const risk = check(result, "ai.risk.accuracy");
      expect(risk.pass).toBe(true);
      // The direction split is reported so a repo that only ever hardens is
      // visibly different from one that also earns its downgrades. Two
      // downgrades here: the over-graded GET, and the woken webhook (an asleep
      // tool baselines at the fail-closed `destructive`).
      expect(risk.detail).toContain("downgrades 2/2");
      expect(risk.detail).toContain("hardenings 1/1");
      expect(risk.detail).toContain("already-correct 1/1");
    });

    it("penalizes a downgrade that never landed", () => {
      // Same over-graded GET, but the judgment never lowered it (queued and
      // declined, rejected by the skeptic, or never proposed).
      const overGraded = staticTools.map((entry) =>
        entry.tool.name === "host_api_invoices_get"
          ? { ...entry, tool: { ...entry.tool, risk: "destructive" as const } }
          : entry);

      const result = scoreAiJudgments({ staticTools: overGraded, judgments: perfectJudgments, expected });
      const risk = check(result, "ai.risk.accuracy");
      expect(risk.pass).toBe(false);
      // The woken webhook still earns its downgrade; the GET does not.
      expect(risk.detail).toContain("downgrades 1/2");
      expect(risk.detail).toContain("host_api_invoices_get");
    });
  });

  it("reads the wake decision from fields.disabled === false", () => {
    // The webhook judgment describes the tool but never wakes it.
    const asleep = {
      ...perfectJudgments,
      host_api_webhooks_unclassified: judgment("host_api_webhooks_unclassified", {
        description: "Receive payment-provider webhook events and update invoice state.",
      }),
    };

    const result = scoreAiJudgments({ staticTools, judgments: asleep, expected });
    const wake = check(result, "ai.wake.correct");
    expect(wake.pass).toBe(false);
    expect(wake.detail).toContain("host_api_webhooks_unclassified");
  });

  it("respects wake:false labels — waking a pinned-asleep tool is wrong", () => {
    const pinned: RepoAiExpectations = {
      version: 1,
      tools: [
        ...expected.tools.slice(0, 3),
        { name: "webhook", method: "POST", path: "/api/webhooks", risk: "write", wake: false },
      ],
    };

    const result = scoreAiJudgments({ staticTools, judgments: perfectJudgments, expected: pinned });
    const wake = check(result, "ai.wake.correct");
    expect(wake.pass).toBe(false);
    expect(wake.detail).toContain("must stay asleep");
  });

  it("scores the confirmEach marks the labels ask for", () => {
    const unconfirmed = {
      ...perfectJudgments,
      host_api_invoices_id_delete: judgment("host_api_invoices_id_delete", {
        description: "Permanently delete an invoice by id; this cannot be undone.",
        risk: "destructive",
      }),
    };

    const result = scoreAiJudgments({ staticTools, judgments: unconfirmed, expected });
    expect(check(result, "ai.confirmEach.applied").pass).toBe(false);
    // Risk still landed, so the two dimensions move independently.
    expect(check(result, "ai.risk.accuracy").pass).toBe(true);
  });

  describe("evidence", () => {
    it("fails an applied judgment that carries no evidence", () => {
      const evidenceless: Record<string, AiScoredJudgment> = {
        ...perfectJudgments,
        host_api_invoices_id_delete: {
          binding: identityOf("host_api_invoices_id_delete"),
          fields: { risk: "destructive", confirmEach: true },
        },
      };

      const result = scoreAiJudgments({ staticTools, judgments: evidenceless, expected });
      const evidence = check(result, "ai.evidence.present");
      expect(evidence.pass).toBe(false);
      expect(evidence.detail).toContain("host_api_invoices_id_delete");
    });

    it("fails on blank evidence, not just a missing key", () => {
      const blank: Record<string, AiScoredJudgment> = {
        ...perfectJudgments,
        host_api_invoices_get: judgment("host_api_invoices_get", { description: "List invoices for the user." }, "   "),
      };

      const result = scoreAiJudgments({ staticTools, judgments: blank, expected });
      expect(check(result, "ai.evidence.present").pass).toBe(false);
    });

    it("does not penalize a bare confirmation that applied no fields", () => {
      // An entry with empty `fields` is the judge saying "I read this, nothing to
      // change". There is no graded claim, so there is nothing for evidence to
      // support.
      const withConfirmation: Record<string, AiScoredJudgment> = {
        ...perfectJudgments,
        host_api_invoices_post: { binding: identityOf("host_api_invoices_post"), fields: {} },
      };

      const result = scoreAiJudgments({ staticTools, judgments: withConfirmation, expected });
      const evidence = check(result, "ai.evidence.present");
      expect(evidence.pass).toBe(true);
      expect(evidence.detail).toContain("1 bare confirmation");
    });
  });

  it("skips label-driven checks gracefully without expectations", () => {
    const result = scoreAiJudgments({ staticTools, judgments: perfectJudgments, expected: null });

    expect(result.checks.some((entry) => entry.id === "ai.risk.accuracy")).toBe(false);
    expect(result.checks.some((entry) => entry.id === "ai.confirmEach.applied")).toBe(false);
    expect(result.checks.some((entry) => entry.id === "ai.wake.correct")).toBe(false);
    expect(check(result, "ai.pass.judged").pass).toBe(true);
    expect(check(result, "ai.evidence.present").pass).toBe(true);
    expect(result.score.value).toBe(1);
  });

  it("scores mechanical, too-short, and resource-less descriptions down", () => {
    const poor: Record<string, AiScoredJudgment> = {
      // Mechanical: equals the path-derived static default.
      host_api_invoices_get: judgment("host_api_invoices_get", { description: "GET /api/invoices" }),
      // Too short, and never mentions invoices.
      host_api_invoices_post: judgment("host_api_invoices_post", { description: "Creates stuff." }),
      // The DELETE tool is never judged at all: coverage drops.
    };

    const result = scoreAiJudgments({ staticTools, judgments: poor, expected });
    expect(check(result, "ai.descriptions.non-mechanical").pass).toBe(false);
    expect(check(result, "ai.descriptions.length").pass).toBe(false);
    expect(check(result, "ai.descriptions.mentions-resource").pass).toBe(false);
    expect(check(result, "ai.descriptions.coverage").pass).toBe(false);
  });

  it("has no brief or draft-guard checks left", () => {
    const result = scoreAiJudgments({ staticTools, judgments: perfectJudgments, expected });
    const ids = result.checks.map((entry) => entry.id);
    expect(ids).not.toContain("ai.brief.drafted");
    expect(ids).not.toContain("ai.guards.clean");
    expect(ids).not.toContain("ai.guards.false-refusals");
  });
});
