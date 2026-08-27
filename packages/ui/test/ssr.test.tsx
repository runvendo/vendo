// @vitest-environment node
import type { ApprovalRequest, VendoAppRef, VendoApprovalRef } from "@vendoai/core";
import { renderToString } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import * as chromeEntry from "../src/chrome/index.js";
import {
  ApprovalCard,
  NoPolicyNotice,
  Remixable,
  VendoOverlay,
  VendoSlot,
  VendoThread,
} from "../src/chrome/index.js";
import { AppFrame, PayloadView, TreeView } from "../src/tree/index.js";
import {
  VendoAppEmbed,
  VendoApprovalEmbed,
  VendoProvider,
  VendoToolResult,
  useActivity,
  useApp,
  useApps,
  useApprovals,
  useAutomations,
  useGrants,
  useVendoStatus,
  useVendoTheme,
  useVendoThread,
} from "../src/index.js";
import * as rootEntry from "../src/index.js";
import * as treeEntry from "../src/tree/index.js";

function EveryContractedHook() {
  const approvals = useApprovals();
  const grants = useGrants();
  const apps = useApps();
  const app = useApp("app_ssr");
  const automations = useAutomations();
  const activity = useActivity();
  const status = useVendoStatus();
  const thread = useVendoThread("thr_ssr");
  const theme = useVendoTheme();
  return (
    <span>
      {[
        approvals.pending.length,
        grants.grants.length,
        apps.apps.length,
        String(app.app),
        String(app.surface),
        automations.automations.length,
        activity.events.length,
        String(status.connected),
        thread.messages.length,
        theme.colors.background,
      ].join("|")}
    </span>
  );
}

describe("public source entries without a DOM", () => {
  it("server-renders every contracted hook from empty transport state", () => {
    expect(rootEntry.useApps).toBe(useApps);
    expect(chromeEntry.VendoOverlay).toBeTypeOf("function");
    expect(treeEntry.TreeView).toBeTypeOf("function");

    const html = renderToString(<VendoProvider><EveryContractedHook /></VendoProvider>);
    expect(html).toContain("0|0|0|undefined|undefined|0|0|false|0|");
  });
});

describe("every chrome surface server-renders without a DOM", () => {
  const approval: ApprovalRequest = {
    id: "apr_ssr",
    call: { id: "call_ssr", tool: "host_email_send", args: { to: "a@example.com" } },
    descriptor: { name: "host_email_send", description: "Send email", inputSchema: {}, risk: "write" },
    inputPreview: "to a@example.com",
    ctx: { principal: { kind: "user", subject: "user_ssr" }, venue: "chat", presence: "present" },
    createdAt: "2026-07-11T12:00:00.000Z",
  };
  const noop = async () => ({ status: "ok", output: null } as const);
  const tree = { formatVersion: "vendo-genui/v2", root: "root", nodes: [{ id: "root", component: "Text", props: { text: "SSR tree" } }] };
  // A NAMED component child: the wrapper derives its slot from the child's
  // identifier (2026-08-02 final shape — the `name` prop is gone).
  const SsrCard = () => <span>original</span>;

  // Each entry is a surface that, without the effects/DOM a browser provides,
  // must still produce markup — proving no unguarded window/document access.
  const surfaces: Array<[string, ReactElement]> = [
    ["VendoThread", <VendoThread />],
    ["VendoOverlay", <VendoOverlay />],
    ["VendoSlot", <VendoSlot id="hero" appId="app_ssr"><span>original</span></VendoSlot>],
    ["Remixable", <Remixable><SsrCard /></Remixable>],
    ["ApprovalCard", <ApprovalCard approval={approval} onDecide={() => undefined} />],
    ["NoPolicyNotice", <NoPolicyNotice />],
    ["TreeView", <TreeView tree={tree} components={{}} onAction={noop} />],
    ["PayloadView", <PayloadView payload={tree} components={{}} onAction={noop} />],
    ["AppFrame", <AppFrame surface={{ kind: "tree", payload: tree }} />],
  ];

  for (const [name, element] of surfaces) {
    it(`server-renders <${name}> without touching window`, () => {
      expect(() => renderToString(<VendoProvider>{element}</VendoProvider>)).not.toThrow();
    });
  }
});

/**
 * An App Router page may drop an embed in bare — the entry's "use client"
 * prologue makes it a client component, and Next still renders it on the
 * server first. That pass is where the shared default context is built, so it
 * has to hold nothing per-request and reach for no window: one module instance
 * serves every request, and the client inside it is a closure over a URL whose
 * auth is the browser's own cookie.
 */
describe("the embeds server-render with no provider", () => {
  const appRef: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_ssr", title: "Invoices", status: "building" };
  const approvalRef: VendoApprovalRef = { kind: "vendo/approval-ref@1", approvalId: "apr_ssr", summary: "Send the report" };
  const bare: Array<[string, ReactElement]> = [
    ["VendoToolResult", <VendoToolResult output={appRef} />],
    ["VendoAppEmbed", <VendoAppEmbed refValue={appRef} />],
    ["VendoApprovalEmbed", <VendoApprovalEmbed refValue={approvalRef} />],
  ];

  for (const [name, element] of bare) {
    it(`server-renders <${name}> with no provider anywhere`, () => {
      expect(renderToString(element)).toContain("vendo-root");
    });
  }
});
