"use client";

import { type ReactNode } from "react";
import { VendoProvider, type ToolMetaMap } from "@vendoai/vendo/react";
import { withBasePath } from "@/lib/base-path";
import { mapleRegistry } from "@/vendo/registry";
import { mapleTheme } from "@/vendo/theme";

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
}) {
  return (
    <VendoProvider
      // The Vendo door under the mount point. The provider's default is the
      // bare `/api/vendo`, which 404s once the app is served at a subpath.
      baseUrl={withBasePath("/api/vendo")}
      components={mapleRegistry}
      theme={mapleTheme}
      // "Pin to dashboard" lands here — placement is a first-class Vendo
      // write, so naming the slot is the whole wiring.
      pinSlot="home-hero"
      tools={mapleToolMeta}
    >
      {children}
    </VendoProvider>
  );
}
