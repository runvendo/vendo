import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Metadata } from "next"
import { Inter } from "next/font/google"
import { AppShell } from "@/components/shell/app-shell"
import { VendoLayer } from "@/components/vendo/VendoLayer"
import { VendoRoot } from "@/components/vendo/VendoRoot"
import "./globals.css"
// What `vendo init` prints: Maple's own font, inlined by `vendo sync`, so Vendo
// surfaces render the brand face instead of falling back to the system stack.
import "../../.vendo/fonts.css"

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" })

// The SAME bytes, as text. A sealed bundle renders in an opaque-origin iframe
// that the stylesheet import above can never reach, so the brand's @font-face
// rules travel to it through the provider (posted in at render by
// `sendFrameTheme`) or the app paints in the fallback stack.
const vendoFonts = readFileSync(join(process.cwd(), ".vendo", "fonts.css"), "utf8")

export const metadata: Metadata = {
  title: "Maple — Banking that keeps up.",
  description: "A modern bank account that actually understands your money.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-bg text-ink antialiased">
        <VendoRoot fonts={vendoFonts}>
          <AppShell>{children}</AppShell>
          <VendoLayer />
        </VendoRoot>
      </body>
    </html>
  )
}
