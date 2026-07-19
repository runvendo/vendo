# ENG-277 generated-component jail inside real Claude/ChatGPT sandboxes

Status 2026-07-17: **PARKED on rendering a jailed component**, because neither
client could be driven to actually render a Vendo generated component with
Yousef's current seats (see ENG-273 findings). The client sessions are live;
the blockers are downstream of the render, so the jail itself was not
exercised in-client this run.

## Captured

- `chatgpt-00-devmode-csp-setting.png` — ChatGPT's Developer-mode security
  panel, including the **"Enforce CSP in developer mode"** control:
  > "When enabled, dev mode apps without a declared CSP get the same restricted
  > default CSP they would in production instead of unrestricted network
  > access."

  This is the ChatGPT-side jail knob: dev-mode MCP-UI apps are governed by a
  production-equivalent default CSP when this is on. (It was left at its default
  OFF — the toggle is a workspace security setting and was not flipped.)

## Why no rendered jailed component yet

- **ChatGPT:** the workspace seat is Codex/Work-only; the Chat surface and the
  connector-add surface are both gated ("Unlock ChatGPT access… Codex-only").
  No MCP-UI app can be rendered from this seat, so the sandbox/CSP could not be
  probed in-client.
- **Claude.ai:** OAuth completes and the 9 Vendo tools register (Umami), but
  Claude does not surface those tools into the chat toolset, so no
  `Vendo apps open/call` render fires. (Maple additionally fails its consent
  POST — see ENG-273 finding 3.)

## Resume

1. Get one client to render a Vendo generated component:
   - ChatGPT: a seat with Chat access + Developer mode → add the Maple/Umami
     connector → invoke a `Vendo apps` tool so the app iframe renders; capture
     with **Enforce CSP ON** for the production-equivalent jail test.
   - Claude: once the chat-tool-loading issue (ENG-273 finding 4) is resolved,
     invoke `Vendo apps open` and capture the rendered app panel.
2. With the component rendered, capture containment evidence: the iframe's
   `sandbox` attributes and the effective `script-src`/`frame-src` CSP, plus a
   demonstration that a jailbreak attempt (e.g. top-nav, parent DOM access,
   disallowed network) is blocked.

Design + prior research: `docs/superpowers/research/2026-07-14-eng-277-jail-sandbox-research.md`
(workstream-B branch) — ChatGPT "likely-works" (permissive frame-src +
`'unsafe-eval'` observed); Claude script-src `'unsafe-eval'` was the open
decisive question.
