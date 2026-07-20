import { describe, expect, it } from "vitest";
import {
  VENDO_APP_REF_KIND,
  VENDO_APPROVAL_REF_KIND,
  parseVendoToolEnvelope,
  vendoAppRefSchema,
  vendoApprovalRefSchema,
  vendoToolEnvelopeSchema,
  type VendoAppRef,
  type VendoApprovalRef,
  type VendoToolEnvelope,
} from "./index.js";

const appRef: VendoAppRef = {
  kind: "vendo/app-ref@1",
  appId: "app_dash",
  title: "Weather dashboard",
};

const approvalRef: VendoApprovalRef = {
  kind: "vendo/approval-ref@1",
  approvalId: "apr_01",
  summary: "Send the trip report to ops@example.com",
};

describe("vendo/app-ref@1", () => {
  it("exports the kind constant and parses the ref", () => {
    expect(VENDO_APP_REF_KIND).toBe("vendo/app-ref@1");
    expect(vendoAppRefSchema.parse(appRef)).toEqual(appRef);
  });

  it("tolerates unknown extra fields (forward compat within @1)", () => {
    const extended = { ...appRef, buildHint: "streaming" };
    expect(vendoAppRefSchema.parse(extended)).toEqual(extended);
  });

  it("rejects a ref missing its app id, a non-app id, or the wrong kind", () => {
    expect(vendoAppRefSchema.safeParse({ kind: "vendo/app-ref@1", title: "x" }).success).toBe(false);
    expect(vendoAppRefSchema.safeParse({ ...appRef, appId: "thr_01" }).success).toBe(false);
    expect(vendoAppRefSchema.safeParse({ ...appRef, kind: "vendo/app-ref@2" }).success).toBe(false);
  });
});

describe("vendo/approval-ref@1", () => {
  it("exports the kind constant and parses the ref", () => {
    expect(VENDO_APPROVAL_REF_KIND).toBe("vendo/approval-ref@1");
    expect(vendoApprovalRefSchema.parse(approvalRef)).toEqual(approvalRef);
  });

  it("rejects a non-approval id and an empty summary", () => {
    expect(vendoApprovalRefSchema.safeParse({ ...approvalRef, approvalId: "app_01" }).success).toBe(false);
    expect(vendoApprovalRefSchema.safeParse({ ...approvalRef, summary: "" }).success).toBe(false);
  });
});

describe("vendoToolEnvelopeSchema", () => {
  it("discriminates both envelope kinds", () => {
    const envelopes: VendoToolEnvelope[] = [appRef, approvalRef];
    for (const envelope of envelopes) {
      expect(vendoToolEnvelopeSchema.parse(envelope)).toEqual(envelope);
    }
  });

  it("rejects unknown kinds", () => {
    expect(vendoToolEnvelopeSchema.safeParse({ kind: "vendo/open-in-product@1", url: "https://x" }).success).toBe(false);
  });
});

describe("parseVendoToolEnvelope", () => {
  it("returns the typed envelope for both kinds", () => {
    expect(parseVendoToolEnvelope(appRef)).toEqual(appRef);
    expect(parseVendoToolEnvelope(approvalRef)).toEqual(approvalRef);
  });

  it("returns null for plain tool data — the executed-cleanly case renders no embed", () => {
    expect(parseVendoToolEnvelope({ delivered: true })).toBeNull();
    expect(parseVendoToolEnvelope("72°F and sunny")).toBeNull();
    expect(parseVendoToolEnvelope(null)).toBeNull();
    expect(parseVendoToolEnvelope(undefined)).toBeNull();
    expect(parseVendoToolEnvelope([appRef])).toBeNull();
  });

  it("returns null for a malformed envelope rather than a partly-typed one", () => {
    expect(parseVendoToolEnvelope({ kind: "vendo/app-ref@1" })).toBeNull();
    expect(parseVendoToolEnvelope({ kind: "vendo/approval-ref@1", approvalId: 7 })).toBeNull();
  });
});
