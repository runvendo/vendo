import { describe, expect, it } from "vitest";
import { vendoApprovalPartSchema, vendoConnectPartSchema, vendoViewPartSchema } from "./stream-parts.js";

/** 01-core §16 — the custom data-parts the wire carries. */
describe("vendoViewPartSchema", () => {
  it("accepts a view part carrying an opaque (forward-version) payload", () => {
    expect(
      vendoViewPartSchema.safeParse({
        type: "data-vendo-view",
        appId: "app_1",
        payload: { formatVersion: "future-ui/v2", opaque: true },
      }).success,
    ).toBe(true);
  });

  it("rejects a wrong type literal or a missing appId", () => {
    expect(
      vendoViewPartSchema.safeParse({ type: "data-view", appId: "app_1", payload: { formatVersion: "x" } }).success,
    ).toBe(false);
    expect(
      vendoViewPartSchema.safeParse({ type: "data-vendo-view", payload: { formatVersion: "x" } }).success,
    ).toBe(false);
  });
});

describe("vendoApprovalPartSchema", () => {
  it("accepts a part with and without the optional approvalId", () => {
    expect(
      vendoApprovalPartSchema.safeParse({
        type: "data-vendo-approval",
        toolCallId: "call_1",
        risk: "destructive",
        approvalId: "apr_1",
      }).success,
    ).toBe(true);
    expect(
      vendoApprovalPartSchema.safeParse({ type: "data-vendo-approval", toolCallId: "call_1", risk: "read" }).success,
    ).toBe(true);
  });

  it("rejects a non-risk-label risk and a malformed approvalId", () => {
    // "critical" is a descriptor flag, not a RiskLabel.
    expect(
      vendoApprovalPartSchema.safeParse({ type: "data-vendo-approval", toolCallId: "call_1", risk: "critical" }).success,
    ).toBe(false);
    expect(
      vendoApprovalPartSchema.safeParse({
        type: "data-vendo-approval",
        toolCallId: "call_1",
        risk: "write",
        approvalId: "xyz_1",
      }).success,
    ).toBe(false);
  });
});

describe("vendoConnectPartSchema", () => {
  it("accepts a connect part naming the connector and toolkit for one tool call", () => {
    expect(
      vendoConnectPartSchema.safeParse({
        type: "data-vendo-connect",
        toolCallId: "call_1",
        connector: "composio",
        toolkit: "gmail",
        message: "Connect your gmail account to run gmail_SEND_EMAIL",
      }).success,
    ).toBe(true);
  });

  it("rejects a wrong type literal or a missing toolkit", () => {
    expect(
      vendoConnectPartSchema.safeParse({
        type: "data-vendo-approval",
        toolCallId: "call_1",
        connector: "composio",
        toolkit: "gmail",
        message: "x",
      }).success,
    ).toBe(false);
    expect(
      vendoConnectPartSchema.safeParse({
        type: "data-vendo-connect",
        toolCallId: "call_1",
        connector: "composio",
        message: "x",
      }).success,
    ).toBe(false);
  });
});
