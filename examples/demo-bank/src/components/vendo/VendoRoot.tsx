"use client";

import { type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { VendoProvider, type ToolMetaMap } from "@vendoai/vendo/react";
import { withBasePath } from "@/lib/base-path";
// Written by `vendo sync` (the `prebuild`/`predev` step) and gitignored, so it
// exists before anything imports it.
import { remixWiring } from "../../../.vendo/generated/remix-wiring";
import { mapleRegistry } from "@/vendo/registry";
import { mapleRoutes } from "@/vendo/routes";
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
  fonts,
}: {
  children: ReactNode;
  /** The TEXT of `.vendo/fonts.css` (read server-side in `layout.tsx`), not a
   *  stylesheet import: a sealed bundle renders in an opaque-origin iframe that
   *  Maple's own stylesheets can never reach, so the brand's `@font-face` rules
   *  are posted in at render (`sendFrameTheme`) or the app paints in the
   *  fallback stack. */
  fonts?: string;
}) {
  const router = useRouter();
  return (
    <VendoProvider
      // The Vendo door under the mount point. The provider's default is the
      // bare `/api/vendo`, which 404s once the app is served at a subpath.
      baseUrl={withBasePath("/api/vendo")}
      components={mapleRegistry}
      // The other half of the sentence `vendo sync` prints: the server catalog
      // knows the hole NAMES, the provider carries their implementations.
      // Without it the renderer paints `Unknown component "AreaChart"`.
      remixWiring={remixWiring}
      theme={mapleTheme}
      {...(fonts === undefined ? {} : { fonts })}
      // No pin wiring: Maple's pages mount their own <VendoSlot>s, and a
      // mounted slot reports itself — so "Pin to dashboard" already knows
      // where it lands.
      tools={mapleToolMeta}
      // Maple's own pages, and Maple's own router doing the moving: a generated
      // <Link to="account"> resolves against this map, and `push` adds the
      // `/maple` basePath that a bare href never would.
      routes={mapleRoutes}
      onNavigate={(nav) => router.push(nav.path)}
    >
      {children}
    </VendoProvider>
  );
}
