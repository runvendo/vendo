"use client";

import { VendoStage } from "@vendoai/ui/voice";
import { VendoRoot } from "@/components/vendo/VendoRoot";

/** ENG-230 — Cadence's voice surface (VendoStage), the sibling of Maple's
 *  /vendo route so voice is covered on BOTH hosts. */
export default function CadenceVoicePage() {
  return (
    <div style={{ height: "calc(100dvh - 120px)", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <VendoRoot>
        <VendoStage />
      </VendoRoot>
    </div>
  );
}
