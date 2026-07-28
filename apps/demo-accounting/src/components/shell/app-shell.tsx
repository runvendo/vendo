import { headers } from "next/headers"
import { isAutologinToken } from "@/server/autologin"
import { resolveCadenceSession, sessionToken } from "@/server/session"
import { Sidebar } from "./sidebar"
import { Topbar, type TopbarUser } from "./topbar"

async function sessionUser(): Promise<TopbarUser | undefined> {
  const cookie = (await headers()).get("cookie")
  if (!cookie) return undefined
  const request = new Request("http://cadence.internal/", { headers: { cookie } })
  const session = await resolveCadenceSession(request)
  if (!session) return undefined
  return {
    display: session.display,
    // Chip gate: the claim rides only proxy-minted tokens (DEMO_AUTOLOGIN);
    // a GoTrue credential login never carries it. The token was just verified
    // by resolveCadenceSession above, so a decode-only claim read is safe.
    autologin: isAutologinToken(sessionToken(request)),
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
