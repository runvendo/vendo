"use client"
import * as React from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ToastProvider } from "@/components/ui/toast"
import { Sidebar } from "./sidebar"
import { Topbar } from "./topbar"
import { CommandPalette } from "./command-palette"

export function AppShell({ children }: { children: React.ReactNode }) {
  const [paletteOpen, setPaletteOpen] = React.useState(false)

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <TooltipProvider>
      <ToastProvider>
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar onOpenPalette={() => setPaletteOpen(true)} />
            <main className="mx-auto w-full max-w-[1200px] flex-1 px-6 py-6">{children}</main>
          </div>
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        </div>
      </ToastProvider>
    </TooltipProvider>
  )
}
