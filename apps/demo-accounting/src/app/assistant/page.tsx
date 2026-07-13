"use client";

import { useState } from "react";
import { ActivityPanel, VendoThread } from "@vendoai/ui/chrome";
import { VendoRoot } from "@/components/vendo/VendoRoot";

function PageSurface() {
  const [activityOpen, setActivityOpen] = useState(false);
  return (
    <div className="fl-page">
      <div className="fl-tabbar">
        <span className="fl-tab" aria-selected="true">Chat</span>
        <button
          type="button"
          className="fl-tab fl-tab-trust"
          aria-label="Activity — what Vendo has done"
          onClick={() => setActivityOpen(true)}
        >
          Activity
        </button>
      </div>
      <div className="fl-page-body">
        <div className="fl-page-pane">
          <VendoThread threadId="thr_cadence_demo" />
        </div>
      </div>
      {activityOpen ? (
        <div className="fl-trust-overlay" role="presentation" onClick={() => setActivityOpen(false)}>
          <div onClick={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => setActivityOpen(false)}>Close</button>
            <ActivityPanel />
            {/* VENDO-MIGRATION: 08-ui ships activity, approvals, and grants
                hooks, but no combined TrustScreen or compiled-rule editor. */}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function AssistantPage() {
  return (
    <div
      style={{
        height: "calc(100dvh - 120px)",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <VendoRoot>
        <PageSurface />
      </VendoRoot>
    </div>
  );
}
