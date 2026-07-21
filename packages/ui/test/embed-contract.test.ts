import { parseVendoToolEnvelope, type VendoAppRef, type VendoApprovalRef } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import type {
  VendoAppEmbedProps,
  VendoApprovalEmbedProps,
  VendoApprovalEmbedState,
  VendoToolResultProps,
} from "../src/index.js";

// Wave 0 contract freeze — the embed prop shapes Lane B builds the three
// components behind. Types only today; these assignments are the compile-time
// assertion that the frozen shapes stay importable from the package root.

describe("embed prop contracts", () => {
  it("VendoAppEmbed takes the app-ref envelope verbatim", () => {
    const refValue: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_x", title: "Dashboard" };
    const props: VendoAppEmbedProps = { refValue };
    expect(props.refValue.appId).toBe("app_x");
  });

  it("VendoApprovalEmbed takes the approval-ref envelope and resolves through the frozen state vocabulary", () => {
    const refValue: VendoApprovalRef = {
      kind: "vendo/approval-ref@1",
      approvalId: "apr_x",
      summary: "Send the report",
    };
    const props: VendoApprovalEmbedProps = { refValue };
    const states: VendoApprovalEmbedState[] = ["pending", "executed", "declined", "expired"];
    expect(props.refValue.approvalId).toBe("apr_x");
    expect(states).toHaveLength(4);
  });

  it("VendoToolResult takes any vendo_* tool output and dispatches on the envelope parse", () => {
    const props: VendoToolResultProps = { output: { delivered: true } };
    expect(parseVendoToolEnvelope(props.output)).toBeNull();
    const appProps: VendoToolResultProps = {
      output: { kind: "vendo/app-ref@1", appId: "app_x", title: "Dashboard" },
    };
    expect(parseVendoToolEnvelope(appProps.output)?.kind).toBe("vendo/app-ref@1");
  });
});
