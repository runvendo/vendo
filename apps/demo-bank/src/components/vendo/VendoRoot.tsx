"use client";

import { useCallback, type ReactNode } from "react";
import { VendoRoot as UmbrellaVendoRoot, type ToolMetaMap } from "@vendoai/vendo/react";
import { mapleRegistry } from "@/vendo/registry";
import { mapleTheme } from "@/vendo/theme";
import { mapleRealtimeVoiceDriver } from "./voice-realtime";

const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Approval-card presentation for Maple's own money tool: the authored title
 *  and cents → dollars on the amount field. Display-only — the raw args still
 *  drive the decision hash (raw value stays on the field's tooltip). */
const mapleToolMeta: ToolMetaMap = {
  host_transferMoney: {
    label: "Send money",
    formatField: (key, value) =>
      key === "amount" && typeof value === "number" ? usd(value) : undefined,
  },
};

export function VendoRoot({
  children,
}: {
  children: ReactNode;
  threadId?: string;
}) {
  // The thread embed's "Pin to dashboard" affordance: record the pin on the
  // app row server-side; the home-hero VendoSlot self-discovers it on its
  // own poll (useSlotApp), so the pinned view lands on Home within seconds.
  const onPin = useCallback((app: { appId: string; payload: unknown }) => {
    void fetch("/api/demo/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: app.appId, slot: "home-hero" }),
    });
  }, []);
  return (
    <UmbrellaVendoRoot
      components={mapleRegistry}
      theme={mapleTheme}
      voice={{ driver: mapleRealtimeVoiceDriver }}
      onPin={onPin}
      tools={mapleToolMeta}
    >
      {/* VENDO-MIGRATION: thread selection moved from the provider to each
          thread surface in 08-ui §3; callers retain the prop during migration. */}
      {children}
    </UmbrellaVendoRoot>
  );
}
