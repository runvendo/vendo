import { describe, expect, it } from "vitest";
import { ruleMatches } from "./rule-match.js";
import type { CompiledRule } from "@vendoai/core";

const base: CompiledRule = {
  id: "r-1", tenantId: "t", subject: "u", kind: "always_ask",
  toolPattern: "send_email", plainText: "sending any email",
  createdAt: "2026-07-04T00:00:00Z",
};

describe("ruleMatches", () => {
  it("exact toolPattern matches the same tool", () => {
    expect(ruleMatches(base, { tool: "send_email", input: {} })).toBe(true);
  });
  it("exact toolPattern never matches a different tool", () => {
    expect(ruleMatches(base, { tool: "other_tool", input: {} })).toBe(false);
  });
  it("glob toolPattern matches a family of tools", () => {
    const rule: CompiledRule = { ...base, toolPattern: "GMAIL_*" };
    expect(ruleMatches(rule, { tool: "GMAIL_SEND_EMAIL", input: {} })).toBe(true);
    expect(ruleMatches(rule, { tool: "SLACK_SEND_MESSAGE", input: {} })).toBe(false);
  });
  it("a constraint narrows the match: a matching value matches, a PROVABLY non-matching value does not", () => {
    const rule: CompiledRule = {
      ...base,
      constraint: { path: "to", op: "matches", value: "*@acme.co" },
    };
    expect(ruleMatches(rule, { tool: "send_email", input: { to: "a@acme.co" } })).toBe(true);
    expect(ruleMatches(rule, { tool: "send_email", input: { to: "a@evil.co" } })).toBe(false);
  });

  it("REVIEW FOLLOW-UP: an unevaluable constraint (missing path) still MATCHES — the rule asks unless provably excluded", () => {
    // Inverted from grant matching on purpose (see this file's docstring): a
    // tighten rule fails toward asking, not toward silently loosening.
    const rule: CompiledRule = {
      ...base,
      constraint: { path: "to", op: "matches", value: "*@acme.co" },
    };
    expect(ruleMatches(rule, { tool: "send_email", input: {} })).toBe(true);
  });

  it("REVIEW FOLLOW-UP: an unevaluable constraint (type mismatch) still MATCHES", () => {
    const rule: CompiledRule = {
      ...base,
      constraint: { path: "amount", op: "gte", value: 100 },
    };
    expect(ruleMatches(rule, { tool: "send_email", input: { amount: "a lot" } })).toBe(true);
  });
  it("a revoked rule never matches", () => {
    expect(ruleMatches({ ...base, revokedAt: "2026-07-04T01:00:00Z" }, { tool: "send_email", input: {} })).toBe(false);
  });
});
