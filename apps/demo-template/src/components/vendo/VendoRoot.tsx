"use client";

import type { ReactNode } from "react";
import { VendoRoot as UmbrellaVendoRoot } from "@vendoai/vendo/react";
import { demoHostComponents } from "@/vendo/host-components";
import { demoTheme } from "@/vendo/theme";

export function VendoRoot({ children }: { children: ReactNode }) {
  return (
    <UmbrellaVendoRoot components={demoHostComponents} theme={demoTheme}>
      {children}
    </UmbrellaVendoRoot>
  );
}
