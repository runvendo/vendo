# The universal box app template

What every Vendo app is built **from**, inside its box. Vite + React 19 with
`@vendoai/ui` preinstalled. **ONE** universal template, baked once per Vendo
release — nothing company-specific is ever baked into it.

It is not published. It is baked into the box image by
`packages/apps/box/build-template.mjs`, which stages this directory in (e2b
resolves `copy()` sources against that script's directory) and rewrites the
`workspace:*` deps to the packed tarballs it puts beside them.

It lives here rather than under `packages/apps/box/` because the dependency guard
scans a package's whole directory: an app template importing `@vendoai/ui/kit`
inside `packages/apps` would violate `apps → core`, correctly.

## In the box

```
/opt/vendo-box/template   this directory, with node_modules a symlink to ↓
/opt/vendo-box/deps       the deps, installed ONCE at bake time
/opt/vendo-box/pkg        the packed @vendoai/{core,ui} tarballs

cp -a /opt/vendo-box/template/. /app/    ← the agent's first action
```

The copy carries `.vendo/run` and the `node_modules` symlink, so one command is a
warm start. The running box has no registry egress; everything is already there.

## Three ports

| Port | What |
| --- | --- |
| `$PORT` (8080) | the **served app** — `node server.js`, the `.vendo/run` line |
| `5173` | the **dev server** — `npm run dev`, the live preview |
| 8811 | the harness control port (not this template's) |

The dev server binds every interface and accepts any Host header: the box's
ingress reaches it from outside, and the provider's hostname is minted per wake,
so it cannot be enumerated in advance.

## The commands

| Command | Contract |
| --- | --- |
| `npm run dev` | the dev server on 5173 |
| `npm run build` | `vite build` → `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run validate` | **exit 0 = shippable.** Non-zero = not shippable, findings on stdout |

`validate` runs the real toolchain and then checks only what the toolchain cannot
know (the run entry, the manifest parses, every fn is a function, and the built
page has no CDN reference and no absolute asset URL). Code validity comes from
`tsc` and `vite build` — there is no hand-rolled syntax checking, and there must
never be.

## The theme route

`?vendoTheme=<json>` — the apps runtime puts the host's live tokens on the
surface URL and the wire proxy forwards the query string. A malformed value is
ignored: a bad theme must never blank the app. It flows through
`themeCssVariables`, the same flattening the chrome and the jail use, onto the
`--vendo-*` custom properties the Kit's tokens read.

## The files

| File | What |
| --- | --- |
| `src/App.tsx` | **the app — this is the file to edit** |
| `src/main.tsx` | the wiring: brand, provider, frame protocol. Rarely touched |
| `src/theme.ts` | the `?vendoTheme=` reader |
| `src/fn.ts` | `callFn` — the app's own server half |
| `fns.js` | the `POST /fn/<name>` handlers |
| `server.js` | the skin contract + serving the Vite build |
| `vendo.json` | the manifest (`schedules`, `egress`) |
| `run` | the `.vendo/run` line, landed by the bake |
