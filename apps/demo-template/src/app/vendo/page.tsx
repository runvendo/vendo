"use client";

import { VendoThread } from "@vendoai/ui/chrome";
import { VendoRoot } from "@/components/vendo/VendoRoot";

// Minimal panel page — demo chrome (beat chips, CTA, caps) lands in later
// passes; this mounts the Vendo surface itself.
export default function VendoTabPage() {
  return (
    <div
      style={{
        height: "100dvh",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "auto",
      }}
    >
      <VendoRoot>
        <VendoThread />
      </VendoRoot>
    </div>
  );
}
