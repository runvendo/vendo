# ENG-274 — Theme tokens cross the MCP boundary (branded apps inside Claude/ChatGPT)

Linear: https://linear.app/runvendo/issue/ENG-274 · Project spec: `/Users/yousefh/orca/workspaces/flowlet/mcp-door/docs/superpowers/specs/2026-07-14-mcp-door-design.md` (workstream B).

## Context

Read `docs/contracts/00-overview.md`, `docs/contracts/08-ui.md` (theme tokens), `docs/contracts/10-mcp.md`, `docs/contracts/10-mcp-umbrella-hookup.md`. The brand-native promise: apps rendered inside Claude/ChatGPT must carry the host's brand. Today they don't:

- The shim (`packages/ui/src/tree/mcp-shim/entry.tsx`) renders `PayloadView` with **no** `VendoProvider` and **no** `themeVars`.
- The shim HTML template (in `packages/ui/scripts/build-mcp-app-shim.mjs`) uses a different CSS variable namespace (`--color-text-primary`) than the pipeline's `--vendo-*` tokens.
- The host's extracted theme (`.vendo/theme.json`, loaded into `VendoRoot` as `VendoTheme` at init — see how `VendoRoot`/`VendoProvider` turn a theme into CSS vars in `packages/ui`) never crosses the MCP boundary.

The door serves `SHIM_HTML` as a static MCP resource (`packages/mcp/src/door.ts` ReadResource handler). The umbrella (`packages/vendo`) constructs the door from the composed blocks — it already has the host's theme available at `createVendo` time; `mcp: true` must stay one flag, so the theme must flow automatically with no new required host config.

## Deliverable

1. **Unify the namespace**: the shim's own chrome (notices, card, body text) uses the same `--vendo-*` tokens the pipeline uses, with sane fallbacks when a var is absent.
2. **Deliver the theme across the boundary**: give the door a theme seam in its config; the umbrella passes the host's `VendoTheme` through. Inject the theme's CSS variables into the shim HTML the door serves (the ReadResource handler can interpolate a style block into `SHIM_HTML` at serve time — decide the exact mechanism; the shim source stays theme-agnostic). Wire `themeVars`/`VendoProvider` (or the equivalent) around `PayloadView` inside the shim so tree components pick the tokens up.
3. **Through to the jail**: generated components render inside the srcdoc jail iframes within the shim — verify the injected vars reach them (check how the jail inherits/receives CSS vars in the packages/ui renderer/jail code) and fix if they don't.
4. Respect host-client light/dark: keep `color-scheme` handling coherent (the extracted theme may define both modes — follow how `VendoRoot` handles it).

Contract updates: minimal edits to `10-mcp.md`/`10-mcp-umbrella-hookup.md` if the door config shape grows a theme field; flag prominently in the PR.

## Bar

- Unit tests (extend the ENG-275 shim suite) + an e2e assertion in `fixtures/mcp-e2e` that the served shim HTML carries the fixture host's theme vars.
- Browser-verified: screenshots in the PR of the shim rendering a tree app WITH a real extracted theme (use Maple/demo-bank's theme.json) vs before. This is UI-affecting — screenshots are mandatory, tests alone don't count.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green; regenerate `shim-html.gen.ts` after shim-source changes.
- Branch `yousef/eng-274-theme-tokens-cross-the-mcp-boundary` stacked on your ENG-278 branch; note the stack order in the PR. Never commit to main.
