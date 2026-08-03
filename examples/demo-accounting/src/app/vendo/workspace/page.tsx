"use client";

import { VendoPage } from "@vendoai/ui/chrome";
import { VendoRoot } from "@/components/vendo/VendoRoot";

/** ENG-230 — the shipped full-page workspace (VendoPage): thread sidebar, apps,
 *  automations, accounts, orgs and activity tabs, mounted on Cadence. The
 *  standalone surface the ⌘J palette's "Show activity" command routes to. */
export default function VendoWorkspacePage() {
  return (
    <div style={{ height: "calc(100dvh - 120px)", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <VendoRoot>
        <VendoPage />
      </VendoRoot>
    </div>
  );
}
