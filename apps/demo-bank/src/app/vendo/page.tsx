"use client";

import { VendoThread } from "@vendoai/ui/chrome";
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
        <VendoThread threadId="maple-demo" />
        <VendoStage />
      </VendoRoot>
    </div>
  );
}
