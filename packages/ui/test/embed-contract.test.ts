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
    const refValue: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_x", title: "Dashboard", status: "building" };
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

  /** The provider went optional by DEFAULTING, not by growing a knob: these
   *  exhaustive (and excess-checked) key maps fail to compile the day a
   *  client/baseUrl/theme prop appears on any of the three. */
  it("takes no client or config prop of its own, bare or not", () => {
    const appKeys: Record<keyof VendoAppEmbedProps, true> = { refValue: true };
    const approvalKeys: Record<keyof VendoApprovalEmbedProps, true> = { refValue: true };
    const resultKeys: Record<keyof VendoToolResultProps, true> = { output: true };
    expect([Object.keys(appKeys), Object.keys(approvalKeys), Object.keys(resultKeys)])
      .toEqual([["refValue"], ["refValue"], ["output"]]);
  });

  it("VendoToolResult takes any vendo_* tool output and dispatches on the envelope parse", () => {
    const props: VendoToolResultProps = { output: { delivered: true } };
    expect(parseVendoToolEnvelope(props.output)).toBeNull();
    const appProps: VendoToolResultProps = {
      output: { kind: "vendo/app-ref@1", appId: "app_x", title: "Dashboard", status: "building" },
    };
    expect(parseVendoToolEnvelope(appProps.output)?.kind).toBe("vendo/app-ref@1");
  });
});
