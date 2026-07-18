import { describe, expect, it } from "vitest";
import { type ContractV2 } from "./entitlements.js";
import { renderContract } from "./output.js";

const contract: ContractV2 = {
  valid: true,
  contract_version: 2,
  org: { id: "org_1", name: "Acme Inc", slug: "acme" },
  plan: { id: "pro", name: "Pro", status: "active" },
  capabilities: {
    sharing: true,
    registry: true,
    guard_basic: true,
    pinning: false,
    guard_full: false,
    session_replay: false,
    insights: false,
    mcp_broker: false,
    sso_saml: false,
  },
  limits: {
    sandbox_minutes: { included: 5000, used: 1234, remaining: 3766, exhausted: false },
    runs: { included: 25000, used: 0, remaining: 25000, exhausted: false },
    storage_gb: { included: 10, used: 0.4, remaining: 9.6, exhausted: true },
  },
  cache: { ttl_seconds: 600, stale_if_error_seconds: 86400 },
};

describe("contract rendering", () => {
  it("renders capabilities and quotas as plain aligned text", () => {
    expect(renderContract(contract)).toBe(`Vendo Cloud key: valid
Org:  Acme Inc (acme)
Plan: Pro (active)

Capabilities
  ✓ sharing        ✓ registry       ✓ guard_basic
  ✗ pinning        ✗ guard_full     ✗ session_replay
  ✗ insights       ✗ mcp_broker     ✗ sso_saml

Quota (this billing period)
  sandbox_minutes  [█████░░░░░░░░░░░░░░░]  1,234 / 5,000  (3,766 left)
  runs             [░░░░░░░░░░░░░░░░░░░░]      0 / 25,000 (25,000 left)
  storage_gb       [█░░░░░░░░░░░░░░░░░░░]    0.4 / 10     (9.6 left) EXHAUSTED`);
  });

  it("omits an empty org and renders zero quota with an em dash", () => {
    const degraded = {
      ...contract,
      org: { id: "", name: "", slug: "" },
      limits: {
        ...contract.limits,
        runs: { included: 0, used: 0, remaining: 0, exhausted: true },
      },
    };
    expect(renderContract(degraded)).not.toContain("Org:");
    expect(renderContract(degraded)).toContain(`  runs             [${"░".repeat(20)}]      — EXHAUSTED`);
  });

  it("includes stale and degraded state banners", () => {
    expect(renderContract(contract, { state: "stale", fetchedAt: 1_000 })).toMatch(
      /^stale since 1970-01-01T00:16:40.000Z \(console unreachable\)\n/,
    );
    expect(renderContract(contract, { state: "degraded" })).toMatch(
      /^degraded to free entitlements \(console unreachable > 24h\)\n/,
    );
  });

  it("does not claim the key is valid when degraded", () => {
    const rendered = renderContract(contract, { state: "degraded" });
    expect(rendered).not.toContain("Vendo Cloud key: valid");
    expect(rendered).toContain("Vendo Cloud key: unverified (offline)");
  });
});
