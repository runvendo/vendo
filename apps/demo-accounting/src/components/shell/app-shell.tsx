import { Sidebar } from "./sidebar"
import { Topbar } from "./topbar"

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1">
          <div className="mx-auto w-full max-w-[1200px] px-8 py-8">{children}</div>
        </main>
      </div>
    </div>
  )
}
