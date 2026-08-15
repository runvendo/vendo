import type { Metadata } from "next"
import { ClerkProvider } from "@clerk/nextjs"
import { VendoOverlay, VendoProvider } from "@vendoai/vendo/react"
import type { VendoTheme } from "@vendoai/vendo"
import { AppShell } from "@/components/shell/app-shell"
import { clerkEnabled } from "@/server/clerk-config"
import theme from "../../.vendo/theme.json"
import "./globals.css"

export const metadata: Metadata = {
  title: "Crate — order ops",
  description: "Orders, customers, inventory and shipments for a small online store.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The one file `vendo init` will not write for you. baseUrl is the wire
  // mount; until this wrap exists, Vendo is composed but nothing on the page
  // can reach it, and `vendo doctor` says so.
  const app = (
    <html lang="en">
      <body className="min-h-screen bg-bg text-ink antialiased">
        <VendoProvider baseUrl="/api/vendo" theme={theme as VendoTheme}>
          <AppShell>{children}</AppShell>
          {/* The provider is only the wire. This is the visible surface — the
              launcher pill and its panel — and without it there is nothing on
              the page to open, which `vendo doctor` calls out by name. */}
          <VendoOverlay />
        </VendoProvider>
      </body>
    </html>
  )

  // Clerk's provider is skipped entirely when unconfigured, so a fresh clone
  // renders the shop instead of throwing about a missing publishable key.
  return clerkEnabled ? <ClerkProvider>{app}</ClerkProvider> : app
}
