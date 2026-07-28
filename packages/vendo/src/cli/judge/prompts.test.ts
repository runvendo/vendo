import { describe, expect, it } from "vitest";
import type { ExtractedTool } from "@vendoai/actions";
import {
  JUDGE_OUTPUT_RULES,
  composeJudgeInstructions,
  composeSkepticInstructions,
  judgmentFacts,
} from "./prompts.js";

const tool = (name: string, overrides: Partial<ExtractedTool> = {}): ExtractedTool => ({
  name,
  description: `Use this to call ${name}.`,
  inputSchema: { type: "object", properties: { secret: { type: "string" } } },
  risk: "read",
  binding: { kind: "route", method: "GET", path: `/api/${name}`, argsIn: "query" },
  srcHash: `sha256:${name}`,
  ...overrides,
});

describe("JUDGE_OUTPUT_RULES", () => {
  it("lets risk move in BOTH directions (the clamp's one-way rule is gone)", () => {
    expect(JUDGE_OUTPUT_RULES).toMatch(/both directions/i);
    // The old rule's exact promise must NOT survive the carry-over.
    expect(JUDGE_OUTPUT_RULES).not.toMatch(/you can never lower it/i);
  });

  it("allows proposing a wake-up for a scanner-disabled tool", () => {
    expect(JUDGE_OUTPUT_RULES).toContain("disabled: false");
    expect(JUDGE_OUTPUT_RULES).not.toMatch(/You can never enable a disabled tool/i);
  });

  it("requires evidence on EVERY proposal, quoted verbatim from the handler", () => {
    expect(JUDGE_OUTPUT_RULES).toMatch(/evidence/);
    expect(JUDGE_OUTPUT_RULES).toMatch(/verbatim/i);
    expect(JUDGE_OUTPUT_RULES).toMatch(/required/i);
  });

  it("says a loosening is queued for a human rather than applied", () => {
    expect(JUDGE_OUTPUT_RULES).toMatch(/queued|human/i);
  });
});

describe("judgmentFacts", () => {
  it("projects judgment fields only — never the machine skeleton", () => {
    const facts = judgmentFacts([tool("host_a", { critical: true, audience: "operator", disabled: true })]);
    expect(facts).toContain("host_a");
    expect(facts).toContain("GET /api/host_a");
    expect(facts).toContain("operator");
    // inputSchema is machine-owned: a model that cannot see it cannot restate it.
    expect(facts).not.toContain("secret");
    expect(facts).not.toContain("inputSchema");
  });
});

describe("composeJudgeInstructions", () => {
  const base = {
    appName: "acme-app",
    tools: [tool("host_a")],
    overrideNames: [],
    chunk: { index: 0, total: 2 },
    last: false,
  };

  it("carries the app name, the catalog, and the output rules", () => {
    const text = composeJudgeInstructions(base);
    expect(text).toContain("acme-app");
    expect(text).toContain("host_a");
    expect(text).toContain(JUDGE_OUTPUT_RULES);
  });

  it("lists human-overridden tools as read-only context that always wins", () => {
    const text = composeJudgeInstructions({ ...base, overrideNames: ["host_z"] });
    expect(text).toContain("host_z");
    expect(text).toMatch(/always win/i);
    expect(text).toMatch(/do not restate/i);
  });

  it("appends the coverage question ONLY to the last chunk", () => {
    expect(composeJudgeInstructions({ ...base, last: false })).not.toContain("missedSurfaces");
    const last = composeJudgeInstructions({ ...base, last: true });
    expect(last).toContain("missedSurfaces");
    expect(last).toMatch(/zero tools/i);
  });
});

describe("composeSkepticInstructions", () => {
  const subject = {
    tool: tool("host_a", { risk: "destructive" }),
    moves: [{ field: "risk", from: "destructive" as const, to: "read" as const }],
    evidence: "const rows = await db.select().from(invoices)",
    reason: "read-only handler",
  };

  it("asks for a verdict per (tool, field) in the fixed wire shape", () => {
    const text = composeSkepticInstructions({ appName: "acme-app", subjects: [subject] });
    expect(text).toContain("verdicts");
    expect(text).toContain("uphold");
    expect(text).toContain("reject");
    expect(text).toContain("host_a");
    expect(text).toContain("risk");
    expect(text).toContain("const rows = await db.select().from(invoices)");
  });

  it("instructs rejection in BOTH directions and for evidence that is not in the source", () => {
    const text = composeSkepticInstructions({ appName: "acme-app", subjects: [subject] });
    expect(text).toMatch(/hardening/i);
    expect(text).toMatch(/loosening/i);
    expect(text).toMatch(/does not appear|not appear in the source/i);
  });

  it("the re-ask names itself as the second and final look", () => {
    const text = composeSkepticInstructions({ appName: "acme-app", subjects: [subject], reask: true });
    expect(text).toMatch(/did not return a verdict|final/i);
  });
});

// ---------------------------------------------------------------------------
// BUG 2 (live corpus diagnostic): "LOWER it when the handler provably only
// reads" was read as "provably INERT", so the model hedged upward — emitting
// `write` while its own reason asserted no data change. Three verbatim cases:
// skateshop host_revalidate_list ("Only invalidates the Next.js path cache ...
// no data changes" -> write), openstatus host_trpc_edge_get ("GET dispatches
// query (read) procedures" -> write), skateshop host_uploadthing_list ("not an
// app read" used as a write justification).
// ---------------------------------------------------------------------------

describe("JUDGE_OUTPUT_RULES — the risk test is mutation of stored state", () => {
  it("states the actual test rather than the hedge-inviting `provably only reads`", () => {
    expect(JUDGE_OUTPUT_RULES).toMatch(/mutat\w* of stored state|mutates stored state|no mutation of stored state/i);
    expect(JUDGE_OUTPUT_RULES).not.toMatch(/provably only reads/i);
  });

  it("names the four things that are NOT mutations, so they cannot justify `write`", () => {
    expect(JUDGE_OUTPUT_RULES).toMatch(/cache invalidation|invalidating a cache/i);
    expect(JUDGE_OUTPUT_RULES).toMatch(/pure computation/i);
    expect(JUDGE_OUTPUT_RULES).toMatch(/serializ/i);
    expect(JUDGE_OUTPUT_RULES).toMatch(/protocol metadata/i);
  });

  it("requires the grade to agree with the reason", () => {
    expect(JUDGE_OUTPUT_RULES).toMatch(/self-consisten|must agree|contradict/i);
    // The rule has to be stated as a hard consequence, not a suggestion.
    expect(JUDGE_OUTPUT_RULES).toMatch(/risk must be "?read"?/i);
  });

  it("keeps the doctrine: a raise applies, a lowering waits for a human", () => {
    expect(JUDGE_OUTPUT_RULES).toMatch(/raise applies|applies immediately/i);
    expect(JUDGE_OUTPUT_RULES).toMatch(/queued for a human/i);
  });
});
