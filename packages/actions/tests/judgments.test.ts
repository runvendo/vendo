import { describe, expect, it } from "vitest";
import { bindingIdentity } from "../src/binding-identity.js";
import { VENDO_JUDGMENTS_FORMAT, type ExtractedTool, type JudgmentsFile, type ToolJudgment } from "../src/formats.js";
import {
  AUDIENCE_RANK,
  RISK_RANK,
  applyJudgment,
  classifyField,
  pruneJudgments,
  splitProposal,
  type JudgmentProposal,
} from "../src/judgments.js";

const tool = (overrides: Partial<ExtractedTool> = {}): ExtractedTool => ({
  name: "host_invoices_list",
  description: "List invoices",
  inputSchema: { type: "object" },
  risk: "write",
  binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
  ...overrides,
});

const judgment = (overrides: Partial<ToolJudgment> = {}): ToolJudgment => ({
  binding: "GET /api/invoices",
  evidence: "return NextResponse.json(await db.invoice.findMany({ where: { userId: session.user.id } }))",
  fields: {},
  ...overrides,
});

const proposal = (fields: Partial<JudgmentProposal> = {}): JudgmentProposal => ({
  evidence: "const rows = await db.invoice.findMany()",
  ...fields,
});

describe("RISK_RANK / AUDIENCE_RANK", () => {
  it("rank restrictiveness, ascending", () => {
    expect(RISK_RANK).toEqual({ read: 0, write: 1, destructive: 2 });
    // An ungraded tool behaves as end-user-visible, so end-user is the WIDEST
    // grade and internal the narrowest.
    expect(AUDIENCE_RANK).toEqual({ "end-user": 0, operator: 1, internal: 2 });
  });
});

describe("classifyField", () => {
  it("routes a risk raise as a hardening and a risk downgrade as a loosening", () => {
    expect(classifyField(tool({ risk: "write" }), "risk", "destructive")).toBe("harden");
    expect(classifyField(tool({ risk: "write" }), "risk", "read")).toBe("loosen");
  });

  it("routes an audience narrowing as a hardening and a widening as a loosening", () => {
    // Ungraded baseline = end-user (widest): any grade on it narrows.
    expect(classifyField(tool(), "audience", "operator")).toBe("harden");
    expect(classifyField(tool({ audience: "operator" }), "audience", "internal")).toBe("harden");
    expect(classifyField(tool({ audience: "internal" }), "audience", "operator")).toBe("loosen");
    expect(classifyField(tool({ audience: "operator" }), "audience", "end-user")).toBe("loosen");
  });

  it("routes a disable as a hardening and a wake-up as a loosening", () => {
    expect(classifyField(tool(), "disabled", true)).toBe("harden");
    expect(classifyField(tool({ disabled: true }), "disabled", false)).toBe("loosen");
  });

  it("routes marking confirmEach as a hardening and clearing it as a loosening", () => {
    expect(classifyField(tool(), "confirmEach", true)).toBe("harden");
    expect(classifyField(tool({ confirmEach: true }), "confirmEach", false)).toBe("loosen");
  });

  it("routes prose and semantics with the hardenings — the AI is the sole description author", () => {
    expect(classifyField(tool(), "description", "Lists the signed-in client's invoices")).toBe("harden");
    expect(classifyField(tool(), "title", "Invoices")).toBe("harden");
    expect(classifyField(tool(), "semantics", { "data.amountCents": { kind: "money", unit: "cents" } })).toBe("harden");
  });
});

describe("splitProposal", () => {
  it("splits one proposal into applied hardenings and queued loosenings", () => {
    const { hardenings, loosenings } = splitProposal(tool({ risk: "write" }), proposal({
      description: "Lists the signed-in client's invoices",
      risk: "read",
      disabled: true,
      audience: "operator",
      reason: "the handler scopes every read to the session user",
    }));
    expect(hardenings).toEqual({
      description: "Lists the signed-in client's invoices",
      disabled: true,
      audience: "operator",
    });
    expect(loosenings).toEqual([{
      field: "risk",
      value: "read",
      evidence: "const rows = await db.invoice.findMany()",
      reason: "the handler scopes every read to the session user",
    }]);
  });

  it("drops no-ops from both sides (restating the current grade is not a change)", () => {
    const { hardenings, loosenings } = splitProposal(
      tool({ risk: "write", confirmEach: true, audience: "operator", disabled: true }),
      proposal({ risk: "write", confirmEach: true, audience: "operator", disabled: true }),
    );
    expect(hardenings).toEqual({});
    expect(loosenings).toEqual([]);
  });

  it("a queued loosening always carries evidence; reason is optional", () => {
    const { loosenings } = splitProposal(tool({ disabled: true }), proposal({ disabled: false }));
    expect(loosenings).toEqual([{ field: "disabled", value: false, evidence: "const rows = await db.invoice.findMany()" }]);
  });

  it("splits against the EFFECTIVE state — tools.json entry plus already-applied judgment fields", () => {
    const effective = applyJudgment(tool({ risk: "read" }), judgment({ fields: { risk: "destructive" } }));
    // `write` is a hardening against the raw `read` skeleton but a LOOSENING
    // against the destructive grade the standing judgment already applied.
    const { hardenings, loosenings } = splitProposal(effective, proposal({ risk: "write" }));
    expect(hardenings).toEqual({});
    expect(loosenings).toEqual([{ field: "risk", value: "write", evidence: "const rows = await db.invoice.findMany()" }]);
  });
});

describe("applyJudgment", () => {
  it("applies the judgment's fields when the binding still matches", () => {
    const applied = applyJudgment(tool(), judgment({
      fields: { description: "Lists the signed-in client's invoices", risk: "destructive", confirmEach: true },
    }));
    expect(applied).toMatchObject({
      description: "Lists the signed-in client's invoices",
      risk: "destructive",
      confirmEach: true,
    });
  });

  it("leaves the tool untouched when there is no judgment", () => {
    const base = tool();
    expect(applyJudgment(base, undefined)).toEqual(base);
  });

  it("is INERT on a binding mismatch — a stale judgment never grades another handler", () => {
    const base = tool({ binding: { kind: "route", method: "POST", path: "/api/invoices", argsIn: "body" } });
    expect(bindingIdentity(base.binding)).not.toBe("GET /api/invoices");
    const applied = applyJudgment(base, judgment({ fields: { risk: "read", disabled: false, description: "stale" } }));
    expect(applied).toEqual(base);
  });

  it("merges semantics PER KEY over the tool's inferred shape hints, never wholesale", () => {
    const applied = applyJudgment(
      tool({
        semantics: {
          "data.amountCents": { kind: "money", unit: "cents" },
          "data.status": { kind: "enum", labels: { paid: "Paid" } },
        },
      }),
      judgment({ fields: { semantics: {
        "data.status": { kind: "enum", labels: { paid: "Paid", overdue: "Overdue" } },
        "data.paidAt": { kind: "date", format: "iso" },
      } } }),
    );
    expect(applied.semantics).toEqual({
      "data.amountCents": { kind: "money", unit: "cents" },
      "data.status": { kind: "enum", labels: { paid: "Paid", overdue: "Overdue" } },
      "data.paidAt": { kind: "date", format: "iso" },
    });
  });

  it("NEVER applies pending loosenings — they wait for a human", () => {
    const applied = applyJudgment(
      tool({ risk: "destructive", disabled: true }),
      judgment({ pending: [
        { field: "risk", value: "read", evidence: "no writes in the handler" },
        { field: "disabled", value: false, evidence: "scoped to session.user.id" },
      ] }),
    );
    expect(applied.risk).toBe("destructive");
    expect(applied.disabled).toBe(true);
    expect(applied).not.toHaveProperty("pending");
  });

  it("keeps the fail-closed audience coupling: operator/internal composes disabled", () => {
    expect(applyJudgment(tool(), judgment({ fields: { audience: "operator" } })).disabled).toBe(true);
    expect(applyJudgment(tool(), judgment({ fields: { audience: "internal" } })).disabled).toBe(true);
    // An end-user grade never disables anything.
    expect(applyJudgment(tool(), judgment({ fields: { audience: "end-user" } })).disabled).toBeUndefined();
    // The coupling reads the tool's standing grade too, not just the judgment's.
    expect(applyJudgment(tool({ audience: "internal" }), judgment({ fields: { risk: "destructive" } })).disabled).toBe(true);
  });

  it("does not re-compose disabled when it is already true", () => {
    const applied = applyJudgment(tool({ disabled: true }), judgment({ fields: { audience: "operator" } }));
    expect(applied.disabled).toBe(true);
  });
});

describe("pruneJudgments", () => {
  const file = (tools: Record<string, ToolJudgment>): JudgmentsFile => ({ format: VENDO_JUDGMENTS_FORMAT, tools });

  it("keeps entries whose name and binding still match a current tool", () => {
    const pruned = pruneJudgments(file({ host_invoices_list: judgment() }), [tool()]);
    expect(Object.keys(pruned.tools)).toEqual(["host_invoices_list"]);
  });

  it("drops an entry whose tool no longer exists", () => {
    const pruned = pruneJudgments(file({ host_invoices_gone: judgment() }), [tool()]);
    expect(pruned.tools).toEqual({});
  });

  it("drops an entry whose binding moved (same name, different handler)", () => {
    const moved = tool({ binding: { kind: "route", method: "POST", path: "/api/invoices", argsIn: "body" } });
    const pruned = pruneJudgments(file({ host_invoices_list: judgment() }), [moved]);
    expect(pruned.tools).toEqual({});
  });

  it("keeps the file's format tag and any additive keys", () => {
    const pruned = pruneJudgments(
      { ...file({ host_invoices_list: judgment() }), generatedAt: "2026-07-28" } as JudgmentsFile,
      [tool()],
    );
    expect(pruned.format).toBe(VENDO_JUDGMENTS_FORMAT);
    expect((pruned as Record<string, unknown>).generatedAt).toBe("2026-07-28");
  });
});
