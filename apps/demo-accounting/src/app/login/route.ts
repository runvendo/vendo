import { resolveCadenceSession, sessionCookie } from "@/server/session"
import { cadenceDemoEmail, cadenceDemoUsers, supabaseAnonKey, supabaseUrl } from "@/server/users"
import { cadencePublicUrl, publicOrigin, safeReturnTo } from "@/vendo/auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!)
}

function loginPage(request: Request, message?: string, status = 401): Response {
  const url = new URL(request.url)
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"), publicOrigin(request))
  const demoUsers = cadenceDemoUsers().map((user) => escapeHtml(user.email)).join(" · ")
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in to Cadence</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@800&display=swap" rel="stylesheet">
  <style>
    :root { color-scheme: light; font-family: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111111; background: #fbfbfa; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at 80% 0%, rgb(30 127 83 / 5%), transparent 34rem), #fbfbfa; }
    main { width: min(100%, 27rem); padding: 30px; border: 1px solid #ecebe8; border-radius: 12px; background: #fff; box-shadow: 0 22px 70px rgb(17 17 17 / 8%); }
    .mark { font-family: "Manrope", "Inter", ui-sans-serif, system-ui, sans-serif; font-size: 26px; font-weight: 800; letter-spacing: -.035em; color: #111111; }
    .mark .dot { color: #1e7f53; }
    h1 { margin: 24px 0 8px; font-size: 28px; letter-spacing: -.03em; }
    p { margin: 0 0 22px; color: #46443f; line-height: 1.5; }
    label { display: grid; gap: 7px; margin-top: 14px; font-size: 13px; font-weight: 650; }
    input { width: 100%; min-height: 44px; border: 1px solid #ecebe8; border-radius: 8px; padding: 10px 12px; color: #111111; background: #fff; font: inherit; }
    input:focus { outline: 3px solid rgb(17 17 17 / 10%); border-color: #dfddd8; }
    button { width: 100%; min-height: 46px; margin-top: 22px; border: 0; border-radius: 8px; color: #fff; background: #111111; font: 660 15px/1 inherit; cursor: pointer; }
    .error { margin: 0 0 14px; padding: 10px 12px; border-radius: 8px; color: #b0473a; background: #fbede9; font-size: 13px; }
    .fine { margin: 16px 0 0; font-size: 12px; text-align: center; color: #908c85; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">cadence<span class="dot">.</span></div>
    <h1>Welcome back</h1>
    <p>Sign in to Cadence to keep your clients on schedule.</p>
    ${message ? `<div class="error" role="alert">${escapeHtml(message)}</div>` : ""}
    <form method="post" action="/login">
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
      <label>Email<input name="email" type="email" autocomplete="username" value="${escapeHtml(cadenceDemoEmail())}" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required autofocus></label>
      <button type="submit">Sign in</button>
    </form>
    <p class="fine">Demo users: ${demoUsers}</p>
    <p class="fine">Cadence is a deterministic demo. No real client data.</p>
  </main>
</body>
</html>`
  return new Response(html, {
    status: message ? status : 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  })
}

export async function GET(request: Request): Promise<Response> {
  const session = await resolveCadenceSession(request)
  if (session) {
    const url = new URL(request.url)
    const returnTo = safeReturnTo(url.searchParams.get("returnTo"), publicOrigin(request))
    return new Response(null, {
      status: 303,
      headers: { location: cadencePublicUrl(request, returnTo).toString(), "cache-control": "no-store" },
    })
  }
  return loginPage(request)
}

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return new Response("Expected form data", { status: 415 })
  }
  const form = new URLSearchParams(await request.text())
  const returnTo = safeReturnTo(form.get("returnTo"), publicOrigin(request))
  const errorPage = (message: string, status?: number) =>
    loginPage(
      new Request(cadencePublicUrl(request, `/login?returnTo=${encodeURIComponent(returnTo)}`)),
      message,
      status,
    )

  // Real Supabase Auth: GoTrue's password grant verifies the credentials and
  // issues the HS256 access token this demo uses as its session.
  let grant: Response
  try {
    grant = await fetch(`${supabaseUrl()}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: supabaseAnonKey() },
      body: JSON.stringify({ email: form.get("email") ?? "", password: form.get("password") ?? "" }),
    })
  } catch {
    return errorPage(
      "Supabase Auth is unreachable. Start the local stack with `supabase start` (see the README).",
      503,
    )
  }
  if (!grant.ok) {
    return errorPage("Email or password is incorrect.")
  }
  const session = (await grant.json()) as { access_token?: string; expires_in?: number }
  if (typeof session.access_token !== "string" || session.access_token.length === 0) {
    return errorPage("Supabase Auth returned an unexpected response.", 502)
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: cadencePublicUrl(request, returnTo).toString(),
      "set-cookie": sessionCookie(session.access_token, session.expires_in ?? 3600),
      "cache-control": "no-store",
    },
  })
}
