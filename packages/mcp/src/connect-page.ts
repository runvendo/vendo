import type { VendoTheme } from "@vendoai/core";
import { escapeHtml, htmlPage, themeAttribute } from "./page-chrome.js";

/**
 * 10-mcp — the door's front door for PEOPLE. Everything else the door serves is
 * for a machine; this page exists because the human step ("what URL do I paste,
 * and where?") is the one part of connecting an MCP client that no protocol
 * endpoint can answer. Unauthenticated and session-free by design: it reveals
 * only what any client is about to be told anyway — the product's name and the
 * transport URL that is already in the public server card.
 *
 * No JavaScript, ever (see `htmlPage`'s CSP). That rules out a scripted
 * copy-to-clipboard button, so the URL ships as a readonly field a person can
 * click and copy with the keyboard — a working affordance instead of a pretty
 * broken one.
 */

const CURSOR_DEEPLINK = "cursor://anysphere.cursor-deeplink/mcp/install";

export function connectPage(input: {
  productName: string;
  mcpUrl: string;
  theme?: VendoTheme;
}): Response {
  const product = escapeHtml(input.productName);
  const url = escapeHtml(input.mcpUrl);
  const cursorConfig = JSON.stringify({ url: input.mcpUrl });
  const cursorLink = `${CURSOR_DEEPLINK}?name=${encodeURIComponent(input.productName)}`
    + `&config=${encodeURIComponent(base64(cursorConfig))}`;
  const html = `<!doctype html>
<html lang="en"${themeAttribute(input.theme)}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect ${product} to your AI client</title>
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
      place-items: start center;
      padding: 28px;
      background:
        radial-gradient(circle at 20% 0%, color-mix(in srgb, var(--vendo-color-accent, #3157d5) 12%, transparent), transparent 38rem),
        var(--vendo-color-background, #f3ede2);
    }
    main {
      width: min(100%, 40rem);
      margin: auto;
      padding: 30px;
      border: 1px solid var(--vendo-color-border, rgba(23, 24, 29, .12));
      border-top: 3px solid var(--vendo-color-accent, #3157d5);
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
    .lede { max-width: 34em; }
    /* The URL: the one artifact a person came here for. An inset well (darker
       at the top, per the light-from-above model) reads as a field to take
       something OUT of, not a form to fill in. */
    .url {
      margin-top: 26px;
      padding: 14px;
      border-radius: var(--vendo-radius-small, 10px);
      background: color-mix(in srgb, var(--vendo-color-surface, #fffdf9) 72%, var(--vendo-color-background, #f3ede2));
      box-shadow: inset 0 1px 2px color-mix(in srgb, var(--vendo-color-text, #17181d) 10%, transparent);
    }
    .url label {
      display: block;
      margin-bottom: 8px;
      color: var(--vendo-color-muted, #686a73);
      font-size: .74rem;
      font-weight: 650;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .url input {
      width: 100%;
      border: 0;
      padding: 0;
      color: var(--vendo-color-text, #17181d);
      background: transparent;
      font: 550 .95rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      overflow-wrap: anywhere;
    }
    .url input:focus-visible {
      outline: 3px solid color-mix(in srgb, var(--vendo-color-accent, #3157d5) 35%, transparent);
      outline-offset: 3px;
      border-radius: 3px;
    }
    .hint { margin-top: 8px; font-size: .78rem; }
    section { margin-top: 30px; }
    h2 {
      margin: 0 0 var(--vendo-density-content-gap, 10px);
      font-size: .95rem;
      font-weight: 650;
      letter-spacing: -.01em;
    }
    ol {
      margin: 0;
      padding: 0;
      list-style: none;
      counter-reset: step;
      display: grid;
      gap: 8px;
    }
    /* A two-column grid needs exactly TWO items: the ::before marker and ONE
       wrapper. Inline children (<strong>) would otherwise each become their own
       grid item and stack down column 1 — hence the <span> around every step. */
    ol li {
      counter-increment: step;
      display: grid;
      grid-template-columns: 1.4rem 1fr;
      align-items: start;
      gap: var(--vendo-density-content-gap, 10px);
      color: var(--vendo-color-muted, #686a73);
      line-height: 1.5;
    }
    ol li strong { color: var(--vendo-color-text, #17181d); font-weight: 650; }
    ol li::before {
      content: counter(step);
      margin-top: .12em;
      width: 1.4rem;
      height: 1.4rem;
      display: grid;
      place-items: center;
      border-radius: 999px;
      background: color-mix(in srgb, var(--vendo-color-accent, #3157d5) 14%, transparent);
      color: var(--vendo-color-text, #17181d);
      font-size: .72rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    kbd {
      padding: .05em .35em;
      border-radius: 4px;
      background: color-mix(in srgb, var(--vendo-color-text, #17181d) 8%, transparent);
      color: var(--vendo-color-text, #17181d);
      font: inherit;
      font-weight: 600;
      white-space: nowrap;
    }
    .cta {
      display: inline-block;
      min-height: 2.7rem;
      margin-top: 14px;
      border: 1px solid transparent;
      border-radius: var(--vendo-radius-small, 10px);
      padding: .75rem 1.1rem;
      color: var(--vendo-color-accent-text, #fff);
      background: var(--vendo-color-accent, #3157d5);
      font: 650 .95rem/1 var(--vendo-font-family, inherit);
      text-decoration: none;
      transition: transform 160ms cubic-bezier(.23, 1, .32, 1);
    }
    .cta:active { transform: scale(.97); }
    .cta:focus-visible {
      outline: 3px solid color-mix(in srgb, var(--vendo-color-accent, #3157d5) 35%, transparent);
      outline-offset: 2px;
    }
    pre {
      margin: var(--vendo-density-content-gap, 10px) 0 0;
      padding: 12px;
      border-radius: var(--vendo-radius-small, 10px);
      background: color-mix(in srgb, var(--vendo-color-text, #17181d) 6%, transparent);
      color: var(--vendo-color-text, #17181d);
      font: 500 .82rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      overflow-x: auto;
    }
    .fine {
      margin-top: 26px;
      padding-top: 16px;
      border-top: 1px solid var(--vendo-color-border, rgba(23, 24, 29, .12));
      font-size: .78rem;
    }
    @media (prefers-reduced-motion: reduce) {
      .cta { transition: none; }
      .cta:active { transform: none; }
    }
    @media (max-width: 30rem) {
      main { padding: 24px 18px; }
      .cta { display: block; text-align: center; }
    }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">V</div>
    <h1>Connect ${product} to your AI client</h1>
    <p class="lede">Add ${product} as a connector and your assistant can act on your account — reading and doing exactly what you can do yourself, with this product's own approvals still in force.</p>

    <div class="url">
      <label for="mcp-url">Your ${product} MCP server URL</label>
      <input id="mcp-url" type="text" readonly value="${url}" spellcheck="false" autocomplete="off">
    </div>
    <p class="hint">Click the field, then <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>A</kbd> and <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>C</kbd> to copy it.</p>

    <section>
      <h2>Claude</h2>
      <ol>
        <li><span>Open <strong>Settings &rarr; Connectors</strong>.</span></li>
        <li><span>Choose <strong>Add custom connector</strong>.</span></li>
        <li><span>Paste the URL above and finish signing in to ${product}.</span></li>
      </ol>
    </section>

    <section>
      <h2>ChatGPT</h2>
      <ol>
        <li><span>In <strong>Settings &rarr; Connectors &rarr; Advanced</strong>, turn on <strong>developer mode</strong>.</span></li>
        <li><span>Choose <strong>Create</strong> to add a custom connector.</span></li>
        <li><span>Paste the URL above and finish signing in to ${product}.</span></li>
      </ol>
    </section>

    <section>
      <h2>Cursor</h2>
      <ol>
        <li><span>Use the one-click install below, or add it by hand in <strong>Settings &rarr; Tools &amp; MCP &rarr; New MCP server</strong>.</span></li>
        <li><span>Finish signing in to ${product} when Cursor opens the browser.</span></li>
      </ol>
      <a class="cta" href="${escapeHtml(cursorLink)}">Add to Cursor</a>
      <pre>${escapeHtml(JSON.stringify({ mcpServers: { [input.productName]: { url: input.mcpUrl } } }, null, 2))}</pre>
    </section>

    <p class="fine">You will be asked to sign in to ${product} and approve access before any client can act. You can revoke a client at any time from ${product}.</p>
  </main>
</body>
</html>`;
  return htmlPage(html);
}

/** Base64 without assuming Node's Buffer (the door runs on Workers too). */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
