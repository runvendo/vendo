"use client";

import { useCallback, type ReactNode } from "react";
import { VendoRoot as UmbrellaVendoRoot } from "@vendoai/vendo/react";
import { mapleRegistry } from "@/vendo/registry";
import { mapleTheme } from "@/vendo/theme";
import { mapleRealtimeVoiceDriver } from "./voice-realtime";

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
    >
      {/* VENDO-MIGRATION: thread selection moved from the provider to each
          thread surface in 08-ui §3; callers retain the prop during migration. */}
      {children}
    </UmbrellaVendoRoot>
  );
}
