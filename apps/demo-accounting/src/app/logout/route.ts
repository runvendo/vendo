import { SESSION_COOKIE } from "@/server/session"

/** Sign out: drop the session cookie and land back on the login form. */
export function GET(request: Request): Response {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : ""
  return new Response(null, {
    status: 303,
    headers: {
      location: "/login",
      "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
      "cache-control": "no-store",
    },
  })
}
