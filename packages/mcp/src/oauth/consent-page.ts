import type {
  VendoTheme,
} from "@vendoai/apps/contract";
import { escapeHtml, htmlPage, themeAttribute } from "../page-chrome.js";

export function consentPage(
  clientName: string,
  scopes: string[],
  flow: { action: string; transaction: string; csrfToken: string },
  theme?: VendoTheme,
): Response {
  const safeClientName = escapeHtml(clientName);
  const themeStyle = themeAttribute(theme);
  const scopeList = scopes.length === 0
    ? ""
    : `<div class="scope"><span>Requested access</span><strong>${escapeHtml(scopes.join(" · "))}</strong></div>`;
  const html = `<!doctype html>
<html lang="en"${themeStyle}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize MCP access</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: var(--vendo-font-family, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--vendo-font-size, 15px);
      color: var(--vendo-color-text, #17181d);
      background: var(--vendo-color-background, #f3ede2);
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 28px;
      background:
        radial-gradient(circle at 20% 0%, color-mix(in srgb, var(--vendo-color-accent, #3157d5) 12%, transparent), transparent 38rem),
        var(--vendo-color-background, #f3ede2);
    }
    main {
      width: min(100%, 31rem);
      padding: 30px;
      border: 1px solid var(--vendo-color-border, rgba(23, 24, 29, .12));
      border-radius: var(--vendo-radius-medium, 16px);
      background: var(--vendo-color-surface, #fffdf9);
      box-shadow: 0 22px 70px color-mix(in srgb, var(--vendo-color-text, #17181d) 12%, transparent);
    }
    .mark {
      width: 2.4rem;
      height: 2.4rem;
      display: grid;
      place-items: center;
      border-radius: var(--vendo-radius-small, 10px);
      color: var(--vendo-color-accent-text, #fff);
      background: var(--vendo-color-accent, #3157d5);
      font-weight: 750;
      letter-spacing: -.04em;
    }
    h1 {
      margin: 24px 0 var(--vendo-density-content-gap, 10px);
      font-family: var(--vendo-heading-family, var(--vendo-font-family, inherit));
      font-size: clamp(1.45rem, 4vw, 1.8rem);
      line-height: 1.18;
      letter-spacing: -.025em;
    }
    p { margin: 0; color: var(--vendo-color-muted, #686a73); line-height: 1.55; }
    .scope {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      margin-top: 24px;
      padding: 14px;
      border: 1px solid var(--vendo-color-border, rgba(23, 24, 29, .12));
      border-radius: var(--vendo-radius-small, 10px);
      background: color-mix(in srgb, var(--vendo-color-surface, #fffdf9) 78%, var(--vendo-color-background, #f3ede2));
      font-size: .86rem;
    }
    .scope span { color: var(--vendo-color-muted, #686a73); }
    .scope strong { overflow-wrap: anywhere; text-align: right; }
    form { display: flex; gap: var(--vendo-density-content-gap, 10px); margin-top: 26px; }
    button {
      min-height: 2.7rem;
      flex: 1;
      border: 1px solid var(--vendo-color-border, rgba(23, 24, 29, .14));
      border-radius: var(--vendo-radius-small, 10px);
      padding: .7rem 1rem;
      font: 650 1rem/1 var(--vendo-font-family, inherit);
      color: var(--vendo-color-text, #17181d);
      background: var(--vendo-color-surface, #fffdf9);
      cursor: pointer;
    }
    button:hover { border-color: var(--vendo-color-accent, #3157d5); }
    button:focus-visible { outline: 3px solid color-mix(in srgb, var(--vendo-color-accent, #3157d5) 35%, transparent); outline-offset: 2px; }
    button[value="approve"] {
      border-color: transparent;
      color: var(--vendo-color-accent-text, #fff);
      background: var(--vendo-color-accent, #3157d5);
    }
    .fine { margin-top: 14px; font-size: .78rem; text-align: center; }
    @media (max-width: 30rem) {
      main { padding: 24px 18px; }
      form { flex-direction: column-reverse; }
    }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">V</div>
    <h1>Allow ${safeClientName} to access this product?</h1>
    <p>This client will be able to use the tools available to your account. Vendo's policy, approval, and audit controls still apply.</p>
    ${scopeList}
    <form method="post" action="${escapeHtml(flow.action)}">
      <input type="hidden" name="transaction" value="${escapeHtml(flow.transaction)}">
      <input type="hidden" name="csrf_token" value="${escapeHtml(flow.csrfToken)}">
      <button type="submit" name="decision" value="deny">Deny</button>
      <button type="submit" name="decision" value="approve">Allow</button>
    </form>
    <p class="fine">You can revoke access from this product at any time.</p>
  </main>
</body>
</html>`;
  return htmlPage(html, { formAction: "self" });
}
