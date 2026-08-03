import type { Metadata } from "next"
import { Inter } from "next/font/google"
import { AppShell } from "@/components/shell/app-shell"
import { VendoLayer } from "@/components/vendo/VendoLayer"
import { VendoRoot } from "@/components/vendo/VendoRoot"
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
        <VendoRoot>
          <AppShell>{children}</AppShell>
          <VendoLayer />
        </VendoRoot>
      </body>
    </html>
  )
}
