import type { Metadata } from "next"
import { Inter } from "next/font/google"
import "./globals.css"

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" })

// Minimal neutral favicon as an inline data URI so every page ships a
// <link rel="icon"> and the browser never 404s on /favicon.ico (which shows
// up as a console error in every boot check). The demo creator overwrites
// this with a prospect-brand glyph (or a real icon file) when cloning.
const NEUTRAL_FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%23525252'/%3E%3Ccircle cx='8' cy='8' r='3' fill='%23fafafa'/%3E%3C/svg%3E"

export const metadata: Metadata = {
  title: "Demo Template",
  description: "Vendo demo-creator template app.",
  icons: { icon: NEUTRAL_FAVICON },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-bg text-ink antialiased">{children}</body>
    </html>
  )
}
