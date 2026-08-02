import type { Metadata } from "next"
import { Inter, Manrope, Spline_Sans_Mono } from "next/font/google"
import { AppShell } from "@/components/shell/app-shell"
import { VendoLayer } from "@/components/vendo/VendoLayer"
import "./globals.css"

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" })
const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" })
const splineMono = Spline_Sans_Mono({ subsets: ["latin"], variable: "--font-spline-mono" })

export const metadata: Metadata = {
  title: "Cadence — Practice management for accounting firms",
  description:
    "Client onboarding, document collection, deadlines, and client comms for accounting firms.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${manrope.variable} ${splineMono.variable}`}>
      <body className="min-h-screen antialiased">
        {/* Vendo's layer wraps the app and owns the Cmd/Ctrl+K overlay. */}
        <VendoLayer>
          <AppShell>{children}</AppShell>
        </VendoLayer>
      </body>
    </html>
  )
}
