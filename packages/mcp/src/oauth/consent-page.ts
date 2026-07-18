import type { VendoTheme } from "@vendoai/core";

export function consentPage(
  clientName: string,
  scopes: string[],
  flow: { action: string; transaction: string; csrfToken: string },
  theme?: VendoTheme,
): Response {
  const safeClientName = escapeHtml(clientName);
  const themeStyle = theme === undefined ? "" : ` style="${escapeHtml(vendoThemeStyle(theme))}"`;
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
      padding: var(--vendo-space-large, 28px);
      background:
        radial-gradient(circle at 20% 0%, color-mix(in srgb, var(--vendo-color-accent, #3157d5) 12%, transparent), transparent 38rem),
        var(--vendo-color-background, #f3ede2);
    }
    main {
      width: min(100%, 31rem);
      padding: var(--vendo-space-large, 30px);
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
      margin: var(--vendo-space-large, 24px) 0 var(--vendo-space-small, 10px);
      font-family: var(--vendo-heading-family, var(--vendo-font-family, inherit));
      font-size: clamp(1.45rem, 4vw, 1.8rem);
      line-height: 1.18;
      letter-spacing: -.025em;
    }
    p { margin: 0; color: var(--vendo-color-muted, #686a73); line-height: 1.55; }
    .scope {
      display: flex;
      justify-content: space-between;
      gap: var(--vendo-space-medium, 14px);
      margin-top: var(--vendo-space-large, 24px);
      padding: var(--vendo-space-medium, 14px);
      border: 1px solid var(--vendo-color-border, rgba(23, 24, 29, .12));
      border-radius: var(--vendo-radius-small, 10px);
      background: color-mix(in srgb, var(--vendo-color-surface, #fffdf9) 78%, var(--vendo-color-background, #f3ede2));
      font-size: .86rem;
    }
    .scope span { color: var(--vendo-color-muted, #686a73); }
    .scope strong { overflow-wrap: anywhere; text-align: right; }
    form { display: flex; gap: var(--vendo-space-small, 10px); margin-top: var(--vendo-space-large, 26px); }
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
    .fine { margin-top: var(--vendo-space-medium, 14px); font-size: .78rem; text-align: center; }
    @media (max-width: 30rem) {
      main { padding: var(--vendo-space-large, 24px) var(--vendo-space-medium, 18px); }
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
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Intentionally mirrors `@vendoai/ui`'s theme-token mapping (`packages/ui/src/theme.ts`)
 * rather than importing it: `scripts/dependency-guard.mjs` restricts `@vendoai/mcp` to
 * `@vendoai/core` only, so ui is not an importable dependency here. There is no shared
 * home for this mapping today — core does not carry it, and ui does not re-export it from
 * core — so any change to ui's theme→CSS-variable mapping must be mirrored here by eye. */
function vendoThemeStyle(theme: VendoTheme): string {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.colors)) {
    variables[`--vendo-color-${kebab(key)}`] = value;
  }
  variables["--vendo-font-family"] = theme.typography.fontFamily;
  if (theme.typography.headingFamily !== undefined) {
    variables["--vendo-heading-family"] = theme.typography.headingFamily;
  }
  variables["--vendo-font-size"] = theme.typography.baseSize;
  for (const [key, value] of Object.entries(theme.radius)) {
    variables[`--vendo-radius-${kebab(key)}`] = value;
  }
  variables["--vendo-density"] = theme.density;
  variables["--vendo-motion"] = theme.motion;
  return Object.entries(variables).map(([name, value]) => `${name}:${value}`).join(";");
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}
