"use client";

import type { ReactNode } from "react";
import { VendoRoot as UmbrellaVendoRoot } from "@vendoai/vendo/react";
import { cadenceHostComponents } from "@/vendo/host-components";
import { cadenceTheme } from "@/vendo/theme";

export function VendoRoot({
  children,
}: {
  children: ReactNode;
  threadId?: string;
}) {
  return (
    <UmbrellaVendoRoot components={cadenceHostComponents} theme={cadenceTheme}>
      {/* VENDO-MIGRATION: thread selection moved from the provider to each
          thread surface in 08-ui §3; callers retain the prop during migration. */}
      {children}
    </UmbrellaVendoRoot>
  );
}
