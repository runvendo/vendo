"use client";

import { useEffect, useRef } from "react";
import { VendoOverlay } from "@vendoai/ui/chrome";
import { VendoRoot } from "./VendoRoot";

async function resetDemo(): Promise<void> {
  try {
    await fetch("/api/demo/reset", { method: "POST" });
  } finally {
    window.location.href = "/";
  }
}

export function VendoLayer() {
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey && event.code === "Period") {
        event.preventDefault();
        void resetDemo();
        return;
      }
      if (!event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        layer.current?.querySelector<HTMLButtonElement>(".vendo-launcher")?.click();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <VendoRoot>
      <div ref={layer} className="maple-vendo-layer">
        <VendoOverlay />
      </div>
      <style jsx global>{`
        .maple-vendo-layer > .vendo-root > .vendo-launcher { display: none; }
      `}</style>
      {/* VENDO-MIGRATION: 08-ui's frozen overlay does not expose custom
          greetings or suggestion chips; Cmd/Ctrl+K behavior remains intact. */}
      {/* VENDO-MIGRATION: connectors remain available to the server-side agent,
          but 08-ui has no integration/OAuth rail or ConnectCard surface. */}
    </VendoRoot>
  );
}
