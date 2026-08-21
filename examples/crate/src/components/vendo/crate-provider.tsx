"use client"

import type { ReactNode } from "react"
import { VendoOverlay, VendoProvider } from "@vendoai/vendo/react"
import type { VendoTheme } from "@vendoai/vendo"
import { crateRegistry } from "@/vendo/registry"
import theme from "../../../.vendo/theme.json"

/**
 * The provider has to live in a "use client" file, and the registry has to come
 * with it. A registry entry holds a component function and a Zod schema, and
 * neither survives the Server→Client boundary: React refuses to serialize them
 * and Next answers the ROOT PAGE with a 500 while the wire keeps working fine.
 * Declaring it in the Server Component layout looks correct and fails this way.
 *
 * `vendo doctor` catches it as E-LIVE-006 and names this exact fix — worth
 * knowing, because the page crashes while every wire check stays green.
 */
export function CrateProvider({ children }: { children: ReactNode }) {
  return (
    <VendoProvider
      baseUrl="/api/vendo"
      theme={theme as VendoTheme}
      // The render half of the registry. The wire route briefs the model with
      // the same object, so a component the model is told about can never be
      // one the page cannot mount.
      components={crateRegistry}
    >
      {children}
      {/* The provider is only the wire. This is the visible surface — the
          launcher pill and its panel — and without it there is nothing on the
          page to open, which `vendo doctor` calls out by name. */}
      <VendoOverlay />
    </VendoProvider>
  )
}
