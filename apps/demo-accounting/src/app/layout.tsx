import type { Metadata } from "next"
import { Hanken_Grotesk, Spline_Sans_Mono } from "next/font/google"
import { AppShell } from "@/components/shell/app-shell"
import { FlowletLayer } from "@/components/flowlet/FlowletLayer"
import "./globals.css"

const hanken = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken" })
const splineMono = Spline_Sans_Mono({ subsets: ["latin"], variable: "--font-spline-mono" })

export const metadata: Metadata = {
  title: "Cadence — Practice management for accounting firms",
  description:
    "Client onboarding, document collection, deadlines, and client comms for accounting firms.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${hanken.variable} ${splineMono.variable}`}>
      <body className="min-h-screen antialiased">
        {/* Flowlet's layer WRAPS the app: the Cmd/Ctrl+K overlay, automation
            toasts, and the shared provider that FlowletRemix wrappers inside
            the page reach for scoping and pinned remixes. */}
        <FlowletLayer>
          <AppShell>{children}</AppShell>
        </FlowletLayer>
      </body>
    </html>
  )
}
