# ENG-279 branded app rendered + interacted inside Claude and ChatGPT

Status 2026-07-17: **PARKED on the branded-app render/interaction.** ENG-274
(theme tokens across the MCP boundary) is merged, so a branded capture is
valid, but neither client could be driven to render a Vendo generated app this
run (see ENG-273 findings) — so the *app* branding was not captured in-client.
The Vendo *door* branding was captured.

## Captured

- `branded-consent-claude-umami.png` / `branded-consent-claude-maple.png` — the
  Vendo-branded OAuth consent page rendered inside Claude.ai for both hosts
  ("Allow Claude to access this product? … Vendo's policy, approval, and audit
  controls still apply.", Vendo mark). This is the door surface, branded.

## Why no branded app yet

Same downstream blockers as ENG-273 / ENG-277:
- ChatGPT: Codex/Work-only seat gates the Chat + connector-add surfaces.
- Claude.ai: OAuth + tool registration succeed (Umami, 9 tools) but Vendo tools
  do not load into the chat toolset, so `Vendo apps open` never renders an app;
  Maple additionally fails its consent POST.

Additionally confirm the deployed host serves the post-ENG-274 themed shim
before capturing (redeploy `maple-mcp-demo` from current main if needed).

## Resume

Once a client renders a Vendo app (see ENG-277 resume): open a Vendo tree app
via the Maple/Umami connector, show the host branding visibly in the rendered
component, interact with it, and drive one `vendo_apps_call` action through an
approval park → resolve. Capture per-beat PNGs + a GIF here.
