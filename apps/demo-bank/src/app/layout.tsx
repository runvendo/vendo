import type { Metadata } from "next"
import { Inter } from "next/font/google"
import { AppShell } from "@/components/shell/app-shell"
import { FlowletLayer } from "@/components/flowlet/FlowletLayer"
import "./globals.css"

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" })

export const metadata: Metadata = {
  title: "Maple — Banking that keeps up.",
  description: "A modern bank account that actually understands your money.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-bg text-ink antialiased">
        <AppShell>{children}</AppShell>
        <FlowletLayer />
      </body>
    </html>
  )
}
