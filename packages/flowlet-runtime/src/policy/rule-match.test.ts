import { describe, expect, it } from "vitest";
import { ruleMatches } from "./rule-match";
import type { CompiledRule } from "@flowlet/core";

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
  it("a constraint narrows the match; missing field fails closed", () => {
    const rule: CompiledRule = {
      ...base,
      constraint: { path: "to", op: "matches", value: "*@acme.co" },
    };
    expect(ruleMatches(rule, { tool: "send_email", input: { to: "a@acme.co" } })).toBe(true);
    expect(ruleMatches(rule, { tool: "send_email", input: { to: "a@evil.co" } })).toBe(false);
    expect(ruleMatches(rule, { tool: "send_email", input: {} })).toBe(false);
  });
  it("a revoked rule never matches", () => {
    expect(ruleMatches({ ...base, revokedAt: "2026-07-04T01:00:00Z" }, { tool: "send_email", input: {} })).toBe(false);
  });
});
