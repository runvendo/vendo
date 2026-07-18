"use client";

import { VendoActivities, VendoThread } from "@vendoai/ui/chrome";
import { VendoStage } from "@vendoai/ui/voice";
import { VendoRoot } from "@/components/vendo/VendoRoot";

export default function VendoTabPage() {
  return (
    <div
      style={{
        height: "calc(100dvh - 112px)",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "auto",
      }}
    >
      <VendoRoot>
        {/* ENG-286 → shelf: the hand-rolled MapleApprovals inbox is now the
            shipped VendoActivities piece — pending approvals (including calls
            arriving through the MCP door) plus the recent agent-activity feed. */}
        <div className="pb-4">
          <VendoActivities />
        </div>
        <VendoThread />
        <VendoStage />
      </VendoRoot>
    </div>
  );
}
