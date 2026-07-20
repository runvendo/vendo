import { describe, expect, it } from "vitest";
import {
  toVendoWirePart,
  vendoApprovalPartSchema,
  vendoStepLimitPartSchema,
  vendoConnectPartSchema,
  vendoViewPartSchema,
  vendoViewWirePartSchema,
} from "./stream-parts.js";

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

/** AGENT-10 (wave 5, additive): the nested ai-SDK envelope the wire and
 *  persisted UIMessages actually carry — `{ type, data: {...}, id? }`. */
describe("wire envelopes for §16 parts", () => {
  it("toVendoWirePart nests every flat field under data and carries the reconciliation id", () => {
    const flat = {
      type: "data-vendo-view" as const,
      appId: "app_1",
      payload: { formatVersion: "vendo-genui/v2", root: "r", nodes: [] },
    };
    expect(toVendoWirePart(flat, "vendo-view:app_1")).toEqual({
      type: "data-vendo-view",
      id: "vendo-view:app_1",
      data: { appId: "app_1", payload: flat.payload },
    });
    expect(toVendoWirePart(flat)).toEqual({
      type: "data-vendo-view",
      data: { appId: "app_1", payload: flat.payload },
    });
  });

  it("vendoViewWirePartSchema parses the nested shape and rejects the flat one", () => {
    const wire = {
      type: "data-vendo-view",
      id: "vendo-view:app_1",
      data: { appId: "app_1", payload: { formatVersion: "vendo-genui/v2" } },
    };
    expect(vendoViewWirePartSchema.safeParse(wire).success).toBe(true);
    expect(vendoViewWirePartSchema.safeParse({
      type: "data-vendo-view",
      appId: "app_1",
      payload: { formatVersion: "vendo-genui/v2" },
    }).success).toBe(false);
  });
});

/** AGENT-7 (wave 5, additive): visible step-cap exhaustion. */
describe("vendoStepLimitPartSchema", () => {
  it("accepts a step-limit notice with the cap and a renderable message", () => {
    expect(vendoStepLimitPartSchema.safeParse({
      type: "data-vendo-step-limit",
      limit: 20,
      message: "Stopped after 20 steps.",
    }).success).toBe(true);
  });

  it("rejects a wrong type literal or a non-integer limit", () => {
    expect(vendoStepLimitPartSchema.safeParse({
      type: "data-vendo-view",
      limit: 20,
      message: "x",
    }).success).toBe(false);
    expect(vendoStepLimitPartSchema.safeParse({
      type: "data-vendo-step-limit",
      limit: 1.5,
      message: "x",
    }).success).toBe(false);
  });
});
