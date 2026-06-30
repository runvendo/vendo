"use client"
import * as React from "react"
import { usePathname } from "next/navigation"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ToastProvider } from "@/components/ui/toast"
import { Sidebar } from "./sidebar"
import { Topbar } from "./topbar"
import { CommandPalette } from "./command-palette"

export function AppShell({ children }: { children: React.ReactNode }) {
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const pathname = usePathname()

  // Cmd/Ctrl+K is owned by the Flowlet overlay in this demo. Maple's command
  // palette stays reachable via the topbar search button.

  return (
    <TooltipProvider>
      <ToastProvider>
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar onOpenPalette={() => setPaletteOpen(true)} />
            <main key={pathname} className="mx-auto w-full max-w-[1200px] flex-1 px-6 py-6 animate-fade-in">
              {children}
            </main>
          </div>
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        </div>
      </ToastProvider>
    </TooltipProvider>
  )
}
