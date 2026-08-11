# @vendoai/ui

Everything Vendo that runs in the host's browser: the API client, the
headless React hooks, the optional prebuilt UI, and the renderer that
displays agent-generated interfaces safely.

## The four entry points

| Import | What you get | Use it when |
|---|---|---|
| `@vendoai/ui` | `<VendoProvider>`, `createVendoClient`, and one hook per resource (`useApps`, `useApprovals`, `useVendoThread`, …) | you're building your own UI on Vendo's data |
| `@vendoai/ui/chrome` | the prebuilt, themed surfaces — chat thread, approval cards, launcher | you want Vendo working out of the box |
| `@vendoai/ui/tree` | the renderer that mounts agent-generated UI in a sandboxed iframe, brand-matched via `--vendo-*` CSS variables | rendering generated apps |
| `@vendoai/ui/kit` | the component vocabulary (forms, charts, tables) generated app code builds screens from | inside generated apps — you rarely import this yourself |

## How it fits

Host page wraps itself in `<VendoProvider>` (configures theme, components,
API mount — defaults to `/api/vendo`). Hooks and chrome read that context
and talk to your server through one shared client. The server side lives in
`@vendoai/vendo`; shared types in `@vendoai/core`.

Docs: [Generated UI](https://docs.vendo.run/concepts/generated-ui) ·
[Theming](https://docs.vendo.run/connect/theming)
