"use client";

import type { ReactNode } from "react";
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
  return (
    <UmbrellaVendoRoot
      components={mapleRegistry}
      theme={mapleTheme}
      voice={{ driver: mapleRealtimeVoiceDriver }}
    >
      {/* VENDO-MIGRATION: thread selection moved from the provider to each
          thread surface in 08-ui §3; callers retain the prop during migration. */}
      {children}
    </UmbrellaVendoRoot>
  );
}
