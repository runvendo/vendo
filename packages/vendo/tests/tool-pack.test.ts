import type { Principal, VendoAppRef, VendoApprovalRef } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import {
  VENDO_DELEGATE_TOOL,
  VENDO_MAKE_TOOL,
  VENDO_TOOL_PACK_PREFIX,
  type VendoDelegateResult,
  type VendoToolPackFilter,
  type VendoToolPackOptions,
} from "../src/tool-pack.js";

// Wave 0 contract freeze — these names and option shapes are what the docs,
// the examples, and both umbrella shims build against; Lane A implements
// behind them without moving them.

describe("tool-pack contract", () => {
  it("pins the vendo_* namespace and the two built-in tool names", () => {
    expect(VENDO_TOOL_PACK_PREFIX).toBe("vendo_");
    // The pack's app door IS Vendo's own make tool — one name in-process and
    // over the MCP door, never a BYO-only alias.
    expect(VENDO_MAKE_TOOL).toBe("vendo_make");
    expect(VENDO_DELEGATE_TOOL).toBe("vendo_delegate");
    expect(VENDO_MAKE_TOOL.startsWith(VENDO_TOOL_PACK_PREFIX)).toBe(true);
    expect(VENDO_DELEGATE_TOOL.startsWith(VENDO_TOOL_PACK_PREFIX)).toBe(true);
  });

  it("pins the shim option shapes: per-request principal plus include/exclude", () => {
    const principal: Principal = { kind: "user", subject: "user_byo" };
    const options: VendoToolPackOptions = {
      principal,
      sessionId: "session_host",
      include: ["vendo_make"],
      exclude: ["vendo_delegate"],
    };
    // The filter alone is what the static Mastra shim accepts (principal
    // resolves lazily per call from the framework's runtime context).
    const filter: VendoToolPackFilter = options;
    expect(filter.include).toEqual(["vendo_make"]);
    const bare: VendoToolPackOptions = { principal };
    expect(bare.include).toBeUndefined();
  });

  it("pins vendo_delegate's plain-data result: report summary plus produced refs", () => {
    const appRef: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_x", title: "Dashboard", status: "building" };
    const approvalRef: VendoApprovalRef = {
      kind: "vendo/approval-ref@1",
      approvalId: "apr_x",
      summary: "Send the report",
    };
    const result: VendoDelegateResult = {
      status: "ok",
      summary: "Built the dashboard and queued the send for approval.",
      refs: [appRef, approvalRef],
    };
    expect(result.refs).toHaveLength(2);
  });
});
