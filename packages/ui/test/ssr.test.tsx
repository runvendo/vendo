// @vitest-environment node
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as chromeEntry from "../src/chrome/index.js";
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
