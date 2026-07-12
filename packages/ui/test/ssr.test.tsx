// @vitest-environment node
import type { ApprovalRequest } from "@vendoai/core";
import { renderToString } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import * as chromeEntry from "../src/chrome/index.js";
import {
  ActivityPanel,
  ApprovalCard,
  AutomationsPanel,
  NoPolicyNotice,
  VendoOverlay,
  VendoPage,
  VendoPalette,
  VendoSlot,
  VendoStage,
  VendoThread,
} from "../src/chrome/index.js";
import { AppFrame, PayloadView, TreeView } from "../src/tree/index.js";
import {
  VendoProvider,
  useActivity,
  useApp,
  useApps,
  useApprovals,
  useAutomations,
  useGrants,
  useVendoStatus,
  useVendoTheme,
  useVendoThread,
  useVoice,
} from "../src/index.js";
import * as rootEntry from "../src/index.js";
import * as treeEntry from "../src/tree/index.js";
import * as voiceEntry from "../src/voice/index.js";

function EveryContractedHook() {
  const approvals = useApprovals();
  const grants = useGrants();
  const apps = useApps();
  const app = useApp("app_ssr");
  const automations = useAutomations();
  const activity = useActivity();
  const status = useVendoStatus();
  const thread = useVendoThread("thr_ssr");
  const voice = useVoice();
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
        voice.state,
        theme.colors.background,
      ].join("|")}
    </span>
  );
}

describe("public source entries without a DOM", () => {
  it("server-renders every contracted hook from empty transport state", () => {
    expect(rootEntry.useVoice).toBe(useVoice);
    expect(chromeEntry.VendoPage).toBeTypeOf("function");
    expect(treeEntry.TreeView).toBeTypeOf("function");
    expect(voiceEntry.useVoice).toBe(useVoice);

    const html = renderToString(<VendoProvider><EveryContractedHook /></VendoProvider>);
    expect(html).toContain("0|0|0|undefined|undefined|0|0|false|0|unavailable|");
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
  const tree = { formatVersion: "vendo-genui/v1", root: "root", nodes: [{ id: "root", component: "Text", props: { text: "SSR tree" } }] } as const;

  // Each entry is a surface that, without the effects/DOM a browser provides,
  // must still produce markup — proving no unguarded window/document access.
  const surfaces: Array<[string, ReactElement]> = [
    ["VendoThread", <VendoThread />],
    ["VendoOverlay", <VendoOverlay />],
    ["VendoSlot", <VendoSlot id="hero" appId="app_ssr"><span>original</span></VendoSlot>],
    ["VendoPage", <VendoPage />],
    ["VendoPalette", <VendoPalette />],
    ["VendoStage", <VendoStage />],
    ["ApprovalCard", <ApprovalCard approval={approval} onDecide={() => undefined} />],
    ["ActivityPanel", <ActivityPanel />],
    ["AutomationsPanel", <AutomationsPanel />],
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
