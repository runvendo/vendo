# ENG-277 research — can the generated-component jail survive real MCP Apps sandboxes?

Date: 2026-07-14. Compiled from web + code research ahead of the live verification.
Issue: https://linear.app/runvendo/issue/ENG-277

## What the jail needs (from code)

Sources: `packages/ui/src/tree/jail/JailedComponent.tsx`, `packages/ui/src/tree/jail/runtime-entry.tsx`, `packages/mcp/src/door.ts` (`SHIM_URI = ui://vendo/tree-shim.html`, mime `text/html;profile=mcp-app`), `packages/mcp/src/shim/shim-html.gen.ts`.

Inside the host's app iframe the shim needs:

1. **One inline `<script>`** (whole shim bundle is inline) + inline `<style>` → host CSP must allow `'unsafe-inline'` for script-src/style-src (host nonces would nullify it).
2. **Two nested `srcdoc` iframes** (outer relay + inner runtime), each `sandbox="allow-scripts"`, each with its own meta CSP (`script-src 'nonce-…' 'unsafe-eval'`, `connect-src 'none'`).
3. **`'unsafe-eval'` in effect inside the innermost frame** — the runtime compiles generated TSX with sucrase and executes via `new Function` (runtime-entry.tsx ~line 76). Critical: `about:srcdoc` documents **inherit the embedder's CSP** (intersection semantics) — if the HOST's script-src lacks `'unsafe-eval'`, the jail dies even though Vendo's own meta CSP grants it.
4. **postMessage** across parent↔shim↔outer↔inner with `targetOrigin "*"` + source-identity checks (filters on `vendo: true`).
5. No fetch/blob:/workers/storage; `img-src data:`, `font-src data:`.
6. Vendo declares **no `_meta.ui.csp`** — `appUiMeta()` only sets `ui.resourceUri`, so each host's default policy applies (favorable: no external domains needed).

Structural fact in our favor: `srcdoc` iframes perform no fetch → **not governed by `frame-src`** (the jail already relies on this, browser-verified in Chromium).

## What each host permits

**Spec (ext-apps / SEP-1865):** sandboxed iframes mandatory; web hosts use a cross-origin sandbox proxy with `allow-scripts allow-same-origin`. Default CSP when `ui.csp` omitted: `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'` — `'unsafe-inline'` yes, **`'unsafe-eval'` NOT in the default and not declarable** (ext-apps issue #605 asking for `wasmUnsafeEval` is open). Sources: spec `specification/2026-01-26/apps.mdx`; apps.extensions.modelcontextprotocol.io CSP & CORS doc; github.com/modelcontextprotocol/ext-apps/issues/605.

**ChatGPT (Apps SDK):** widgets load into `{hash}.web-sandbox.oaiusercontent.com` in a sandbox proxy. Live probe of the proxy: `frame-src 'self' https: data: blob:; sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms`. A developer-reported published-app widget CSP includes `script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' 'unsafe-eval' blob: …` (community.openai.com thread 1372222); MCPJam's OpenAI-compatible implementation states `'unsafe-inline'`/`'unsafe-eval'` "currently required for React". Subframes from external origins need `frameDomains` + review scrutiny — but srcdoc frames aren't external-origin fetches.

**Claude.ai:** apps render iframe-in-iframe on `{hash}.claudemcpcontent.com` (claude.com MCP-apps troubleshooting doc). Community-observed hardcoded `frame-src 'self' blob: data:` with `frameDomains`/`resourceDomains` ignored (anthropics/claude-ai-mcp issue #40, open). **Nobody has published Claude's MCP-app `script-src`.** Adjacent: Claude's artifacts sandbox (`www.claudeusercontent.com`, probed live) serves `script-src 'unsafe-eval' 'unsafe-inline' 'self' …`; one low-confidence community article claims eval is blocked in MCP-app iframes.

## Verdicts

- **ChatGPT: likely-works.** Nesting, inline scripts, and (observed) `'unsafe-eval'` all available. Risks: OpenAI docs call unsafe-eval temporary; app review flags subframes (unclear if runtime srcdoc detected).
- **Claude.ai: unknown → live test.** The single decisive question: does the app iframe's inherited `script-src` carry `'unsafe-eval'`? If it follows the spec default, `new Function` throws and generated components break at eval time — everything else (shim, tree primitives, relay handshake) still works.
- Live test is cheap and definitive: a probe app that runs `new Function("return 1")()` and spawns an `<iframe srcdoc>` chain, reporting results in rendered UI, answers everything per client.

## Fallbacks if Claude blocks unsafe-eval

1. **Script-element evaluation instead of `new Function`** (minimal, preserves the whole jail): inject the sucrase-compiled source as a nonce'd inline `<script>` in the inner document (registration-global pattern). Governed by `'unsafe-inline'`/nonces, not `'unsafe-eval'`. Removes the jail's only eval dependency; sucrase itself doesn't eval. **Worth doing regardless** — makes the jail spec-default-compatible.
2. Degrade generated components only: prewired primitives/host components render normally; `JailedComponent` → `ContainedNotice` (core-§8 dispatch already contains this gracefully).
3. Open-in-product card per app (`{ kind: "http", url }` path, ENG-278).
