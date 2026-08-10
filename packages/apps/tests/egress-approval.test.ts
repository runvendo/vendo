import type {
  AppDocument,
} from "../src/contract/index.js";
import { VENDO_APP_FORMAT, VendoError } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import {
  boxAllowlist,
  createEgressApprovals,
  normalizeEgressDomain,
  unapprovedEgress,
} from "../src/server/escalation/egress-approval.js";
import { memoryStore } from "../src/server/testing/memory-store.js";

const app = (overrides: Partial<AppDocument> = {}): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_egress_test",
  name: "Egress fixture",
  ...overrides,
});

describe("egress policy math", () => {
  it("normalizes domains case-insensitively with stray spacing", () => {
    expect(normalizeEgressDomain(" API.Example.COM ")).toBe("api.example.com");
  });

  it("reports declared-but-unapproved domains, normalized and deduped", () => {
    const doc = app({
      egress: ["API.example.com", "api.example.com ", "hooks.stripe.com"],
      egressApproved: ["api.example.com"],
    });
    expect(unapprovedEgress(doc)).toEqual(["hooks.stripe.com"]);
  });

  it("treats no declaration as nothing to approve", () => {
    expect(unapprovedEgress(app())).toEqual([]);
    expect(unapprovedEgress(app({ egress: [] }))).toEqual([]);
  });

  it("ignores approvals for domains no longer declared", () => {
    const doc = app({ egress: ["api.example.com"], egressApproved: ["gone.example.com"] });
    expect(unapprovedEgress(doc)).toEqual(["api.example.com"]);
  });

  it("assembles the allowlist as approved declaration + implicit skin domains", () => {
    const doc = app({
      egress: ["api.example.com", "hooks.stripe.com"],
      egressApproved: ["api.example.com", "hooks.stripe.com"],
    });
    expect(boxAllowlist(doc, ["host.vendo.test", "api.example.com"])).toEqual([
      "api.example.com",
      "hooks.stripe.com",
      "host.vendo.test",
    ]);
  });

  it("is deny-by-default: an undeclared app gets only the implicit skin domains", () => {
    expect(boxAllowlist(app(), ["host.vendo.test"])).toEqual(["host.vendo.test"]);
    expect(boxAllowlist(app(), [])).toEqual([]);
  });

  it("drops approvals for undeclared domains from the allowlist", () => {
    const doc = app({ egress: ["api.example.com"], egressApproved: ["api.example.com", "old.example.com"] });
    expect(boxAllowlist(doc, [])).toEqual(["api.example.com"]);
  });

  it("throws a loud VendoError naming every unapproved domain", () => {
    const doc = app({
      egress: ["api.example.com", "hooks.stripe.com"],
      egressApproved: ["api.example.com"],
    });
    let thrown: unknown;
    try {
      boxAllowlist(doc, ["host.vendo.test"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VendoError);
    expect((thrown as VendoError).code).toBe("blocked");
    expect((thrown as VendoError).message).toContain("hooks.stripe.com");
    expect((thrown as VendoError).detail).toEqual({ unapprovedDomains: ["hooks.stripe.com"] });
  });
});

describe("egress approval store", () => {
  const request = (domain: string, approvalId = "apr_1") => ({
    appId: "app_egress_test" as const,
    domain,
    owner: "user_ada",
    approvalId,
    requestedAt: "2026-07-19T00:00:00.000Z",
  });

  it("parks, lists by approval, and clears on decision", async () => {
    const approvals = createEgressApprovals(memoryStore());
    await approvals.putPending(request("api.example.com"));
    await approvals.putPending(request("hooks.stripe.com"));

    expect((await approvals.byApproval("apr_1")).map((r) => r.domain).sort()).toEqual([
      "api.example.com",
      "hooks.stripe.com",
    ]);
    expect(await approvals.byApproval("apr_other")).toEqual([]);

    await approvals.remove("app_egress_test", "api.example.com");
    expect((await approvals.byApproval("apr_1")).map((r) => r.domain)).toEqual([
      "hooks.stripe.com",
    ]);
  });

  it("re-parking the same domain overwrites instead of duplicating", async () => {
    const approvals = createEgressApprovals(memoryStore());
    await approvals.putPending(request("api.example.com", "apr_1"));
    await approvals.putPending(request("api.example.com", "apr_2"));
    // The overwrite carries the domain onto the NEW approval, so the old one no
    // longer holds it — one parked record, not two.
    expect(await approvals.byApproval("apr_1")).toEqual([]);
    expect((await approvals.byApproval("apr_2")).map((r) => r.domain)).toEqual(["api.example.com"]);
  });

  it("clearForApp removes every parked request for the app", async () => {
    const approvals = createEgressApprovals(memoryStore());
    await approvals.putPending(request("api.example.com"));
    await approvals.putPending(request("hooks.stripe.com"));
    await approvals.clearForApp("app_egress_test");
    expect(await approvals.byApproval("apr_1")).toEqual([]);
  });
});
