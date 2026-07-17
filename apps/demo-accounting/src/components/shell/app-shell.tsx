import { headers } from "next/headers"
import { resolveCadenceSession } from "@/server/session"
import { Sidebar } from "./sidebar"
import { Topbar, type TopbarUser } from "./topbar"

/** Staff with a real headshot in public/avatars; everyone else gets initials. */
const AVATARS: Record<string, string> = {
  "daniel@cadence.test": "/avatars/daniel.jpg",
}

async function sessionUser(): Promise<TopbarUser | undefined> {
  const cookie = (await headers()).get("cookie")
  if (!cookie) return undefined
  const session = await resolveCadenceSession(
    new Request("http://cadence.internal/", { headers: { cookie } }),
  )
  if (!session) return undefined
  return {
    display: session.display,
    avatarUrl: session.email ? AVATARS[session.email] : undefined,
  }
}

export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await sessionUser()
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar user={user} />
        <main className="flex-1">
          <div className="mx-auto w-full max-w-[1200px] px-8 py-8">{children}</div>
        </main>
      </div>
    </div>
  )
}
