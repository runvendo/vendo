import type { Metadata } from "next"
import { AppShell } from "@/components/shell/app-shell"
import "./globals.css"

export const metadata: Metadata = {
  title: "Crate — order ops",
  description: "Orders, customers, inventory and shipments for a small online store.",
}

// ⚠️ ENG-411: `<VendoProvider>` mounts here. `vendo init` prints the paste; it
// never writes this file, so this is the one hand edit the setup asks for.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-ink antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  )
}
