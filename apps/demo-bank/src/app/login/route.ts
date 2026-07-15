import {
  authenticateMapleUser,
  createMapleSessionCookie,
  mapleDemoEmail,
  maplePublicUrl,
  safeReturnTo,
} from "@/vendo/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function loginPage(request: Request, message?: string): Response {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(request, url.searchParams.get("returnTo"));
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in to Maple</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111; background: #fbfbfa; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at 20% 0%, rgb(10 124 255 / 10%), transparent 36rem), #fbfbfa; }
    main { width: min(100%, 27rem); padding: 30px; border: 1px solid #e2e1de; border-radius: 14px; background: #fff; box-shadow: 0 22px 70px rgb(17 17 17 / 10%); }
    .mark { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 12px; color: #fff; background: #0a7cff; font-size: 20px; font-weight: 760; letter-spacing: -.06em; }
    h1 { margin: 24px 0 8px; font-size: 28px; letter-spacing: -.035em; }
    p { margin: 0 0 22px; color: #77736d; line-height: 1.5; }
    label { display: grid; gap: 7px; margin-top: 14px; font-size: 13px; font-weight: 650; }
    input { width: 100%; min-height: 44px; border: 1px solid #dfddd8; border-radius: 10px; padding: 10px 12px; color: #111; background: #fff; font: inherit; }
    input:focus { outline: 3px solid rgb(10 124 255 / 18%); border-color: #0a7cff; }
    button { width: 100%; min-height: 46px; margin-top: 22px; border: 0; border-radius: 10px; color: #fff; background: #0a7cff; font: 680 15px/1 inherit; cursor: pointer; }
    .error { margin: 0 0 14px; padding: 10px 12px; border-radius: 9px; color: #8c241b; background: #fbedeb; font-size: 13px; }
    .fine { margin: 16px 0 0; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">M</div>
    <h1>Welcome back</h1>
    <p>Sign in to Maple to continue your secure connection.</p>
    ${message ? `<div class="error" role="alert">${escapeHtml(message)}</div>` : ""}
    <form method="post" action="/login">
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
      <label>Email<input name="email" type="email" autocomplete="username" value="${escapeHtml(mapleDemoEmail())}" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required autofocus></label>
      <button type="submit">Sign in</button>
    </form>
    <p class="fine">Maple is a deterministic demo. No real money moves.</p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: message ? 401 : 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

export function GET(request: Request): Response {
  return loginPage(request);
}

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return new Response("Expected form data", { status: 415 });
  }
  const form = new URLSearchParams(await request.text());
  const returnTo = safeReturnTo(request, form.get("returnTo"));
  const user = await authenticateMapleUser(form.get("email") ?? "", form.get("password") ?? "");
  if (!user) return loginPage(new Request(maplePublicUrl(request, `/login?returnTo=${encodeURIComponent(returnTo)}`)), "Email or password is incorrect.");

  return new Response(null, {
    status: 303,
    headers: {
      location: maplePublicUrl(request, returnTo).toString(),
      "set-cookie": await createMapleSessionCookie(request, user),
      "cache-control": "no-store",
    },
  });
}
