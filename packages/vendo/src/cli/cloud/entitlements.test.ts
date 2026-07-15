import { describe, expect, it } from "vitest";
import {
  CAPABILITY_KEYS,
  FREE_CONTRACT,
  METER_KEYS,
  isVendoKey,
  parseContractV2,
} from "./entitlements.js";

const response = {
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
    storage_gb: { included: 10, used: 0.4, remaining: 9.6, exhausted: false },
  },
  cache: { ttl_seconds: 600, stale_if_error_seconds: 86400 },
};

describe("contract v2 entitlements", () => {
  it("parses a complete contract", () => {
    expect(parseContractV2(response)).toEqual(response);
  });

  it("tolerates missing and malformed entitlement fields", () => {
    expect(parseContractV2({
      valid: true,
      contract_version: 2,
      org: { id: 1, name: "Acme Inc" },
      plan: null,
      capabilities: { sharing: "yes", registry: true, future_capability: true },
      limits: {
        sandbox_minutes: { included: Number.NaN, used: "12", remaining: Infinity, exhausted: "yes" },
        storage_gb: { included: 10, used: 0.5 },
      },
      cache: { ttl_seconds: "600", stale_if_error_seconds: 12 },
    })).toEqual({
      valid: true,
      contract_version: 2,
      org: { id: "", name: "Acme Inc", slug: "" },
      plan: { id: "", name: "", status: "" },
      capabilities: {
        sharing: false,
        registry: true,
        guard_basic: false,
        pinning: false,
        guard_full: false,
        session_replay: false,
        insights: false,
        mcp_broker: false,
        sso_saml: false,
      },
      limits: {
        sandbox_minutes: { included: 0, used: 0, remaining: 0, exhausted: false },
        runs: { included: 0, used: 0, remaining: 0, exhausted: false },
        storage_gb: { included: 10, used: 0.5, remaining: 0, exhausted: false },
      },
      cache: { ttl_seconds: 600, stale_if_error_seconds: 12 },
    });
  });

  it("rejects older and invalid contracts", () => {
    expect(parseContractV2({ ...response, contract_version: 1 })).toBeNull();
    expect(parseContractV2({ ...response, valid: false })).toBeNull();
    expect(parseContractV2(null)).toBeNull();
  });

  it("defines a fail-closed free contract", () => {
    expect(CAPABILITY_KEYS).toHaveLength(9);
    expect(METER_KEYS).toHaveLength(3);
    expect(Object.values(FREE_CONTRACT.capabilities)).toEqual(Array(9).fill(false));
    expect(Object.values(FREE_CONTRACT.limits)).toEqual(Array(3).fill({
      included: 0,
      used: 0,
      remaining: 0,
      exhausted: true,
    }));
    expect(FREE_CONTRACT.plan).toEqual({ id: "free", name: "Free", status: "degraded" });
  });

  it.each([
    [`vnd_${"0a".repeat(20)}`, true],
    [`vnd_${"f".repeat(40)}`, true],
    ["vnd_test", false],
    [`vnd_${"A".repeat(40)}`, false],
    [`vnd_${"a".repeat(39)}`, false],
    [`xvnd_${"a".repeat(40)}`, false],
  ])("checks API key format for %s", (key, valid) => {
    expect(isVendoKey(key)).toBe(valid);
  });
});
