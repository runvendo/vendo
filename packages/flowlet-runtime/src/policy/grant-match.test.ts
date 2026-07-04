import { describe, expect, it } from "vitest";
import { grantMatches, hashInput } from "./grant-match";
import type { PermissionGrant } from "@flowlet/core";
import { hashDescriptor } from "../automations/grants";
import type { ToolDescriptor } from "../descriptor";

const descriptor: ToolDescriptor = {
  name: "send_email", source: "caller",
  annotations: { readOnlyHint: false }, hasExecute: true, kind: "function",
};
const base: PermissionGrant = {
  id: "g1", tenantId: "t", subject: "u", tool: "send_email",
  descriptorHash: hashDescriptor(descriptor),
  scope: { kind: "tool" }, duration: "standing", source: { kind: "fade" },
  grantedAt: "2026-07-04T00:00:00Z",
};
const ctx = { tool: "send_email", descriptor, input: { to: "a@acme.co", amount: 100 }, now: "2026-07-04T10:00:00Z" };

describe("grantMatches", () => {
  it("tool scope matches any input", () => {
    expect(grantMatches(base, ctx)).toBe(true);
  });
  it("wrong tool name never matches", () => {
    expect(grantMatches({ ...base, tool: "other" }, ctx)).toBe(false);
  });
  it("descriptor drift lapses the grant", () => {
    expect(grantMatches({ ...base, descriptorHash: "stale" }, ctx)).toBe(false);
  });
  it("revoked and expired grants never match", () => {
    expect(grantMatches({ ...base, revokedAt: "2026-07-04T01:00:00Z" }, ctx)).toBe(false);
    expect(grantMatches({ ...base, expiresAt: "2026-07-04T09:00:00Z" }, ctx)).toBe(false);
  });
  it("exact scope matches only the identical input", () => {
    const g: PermissionGrant = { ...base, scope: { kind: "exact", inputHash: hashInput(ctx.input), inputPreview: "…" } };
    expect(grantMatches(g, ctx)).toBe(true);
    expect(grantMatches(g, { ...ctx, input: { to: "b@x.co" } })).toBe(false);
  });
  it("constrained scope: matches/lte ops, missing field fails closed", () => {
    const g: PermissionGrant = {
      ...base,
      scope: { kind: "constrained", constraints: [
        { path: "to", op: "matches", value: "*@acme.co" },
        { path: "amount", op: "lte", value: 500 },
      ]},
    };
    expect(grantMatches(g, ctx)).toBe(true);
    expect(grantMatches(g, { ...ctx, input: { to: "a@evil.co", amount: 100 } })).toBe(false);
    expect(grantMatches(g, { ...ctx, input: { to: "a@acme.co", amount: 900 } })).toBe(false);
    expect(grantMatches(g, { ...ctx, input: { amount: 100 } })).toBe(false); // missing field
  });
  it("session/task grants need the matching contextKey", () => {
    const g: PermissionGrant = { ...base, duration: "session", contextKey: "sess-1" };
    expect(grantMatches(g, { ...ctx, contextKey: "sess-1" })).toBe(true);
    expect(grantMatches(g, { ...ctx, contextKey: "sess-2" })).toBe(false);
    expect(grantMatches(g, ctx)).toBe(false); // no context at all
  });
});
