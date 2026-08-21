import type { Metadata } from "next"
import { ClerkProvider } from "@clerk/nextjs"
import { AppShell } from "@/components/shell/app-shell"
import { CrateProvider } from "@/components/vendo/crate-provider"
import { clerkEnabled } from "@/server/clerk-config"
import "./globals.css"

export const metadata: Metadata = {
  title: "Crate — order ops",
  description: "Orders, customers, inventory and shipments for a small online store.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The one file `vendo init` will not write for you. `<CrateProvider>` is the
  // wire mount; until this wrap exists, Vendo is composed but nothing on the
  // page can reach it, and `vendo doctor` says so.
  //
  // It is a "use client" component rather than <VendoProvider> inline, because
  // the host component registry travels with the provider and a registry entry
  // (a component function, a Zod schema) cannot cross the Server→Client
  // boundary. See the note in crate-provider.tsx.
  const app = (
    <html lang="en">
      <body className="min-h-screen bg-bg text-ink antialiased">
        <CrateProvider>
          <AppShell>{children}</AppShell>
        </CrateProvider>
      </body>
    </html>
  )

  // Clerk's provider is skipped entirely when unconfigured, so a fresh clone
  // renders the shop instead of throwing about a missing publishable key.
  return clerkEnabled ? <ClerkProvider>{app}</ClerkProvider> : app
}
