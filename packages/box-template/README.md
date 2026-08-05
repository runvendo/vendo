# The universal box app template

What every Vendo app is built **from**, inside its box. Vite + React 19 with
`@vendoai/kit` preinstalled. **ONE** universal template, baked once per Vendo
release — nothing company-specific is ever baked into it.

It is not published. It is baked into the box image by
`packages/apps/box/build-template.mjs`, which stages this directory in (e2b
resolves `copy()` sources against that script's directory) and rewrites the
`workspace:*` deps to the packed tarballs it puts beside them.

It lives here rather than under `packages/apps/box/` because the dependency guard
scans a package's whole directory: an app template importing `@vendoai/kit`
inside `packages/apps` would violate `apps → core`, correctly.

## In the box

```
/opt/vendo-box/template   this directory, with node_modules a symlink to ↓
/opt/vendo-box/deps       the deps, installed ONCE at bake time
/opt/vendo-box/pkg        the packed @vendoai/{core,ui,kit} tarballs

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

## What arrives as data, not as a bake

Everything company-specific lands as FILES when the box is provisioned, under a
directory whose layout is byte-identical to a host project's own `.vendo/`:

```
/app/.vendo/host/theme.json                     VendoTheme
/app/.vendo/host/components/<Name>.json         CapturedHostComponent
/app/.vendo/host/components/modules/<hex>.json  CapturedModule { source, imports? }
```

So a producer's whole job is a directory copy of what `vendo sync` already wrote:
no new format, no new transport. `provision.mjs` is the receiving end. It is a
SUBTREE of `.vendo/` because `.vendo/` is the supervisor's control directory — a
host component named `run` must not be able to collide with the entry that starts
the app.

Absent is normal and never fatal: a box provisioned without host data serves on
Vendo's own neutral defaults.

## Two theme routes, both open

1. `?vendoTheme=<json>` — the shipped route; the apps runtime puts the host's live
   tokens on the surface URL and the wire proxy forwards the query string.
2. `.vendo/host/theme.json` — the provisioned brand baseline.

The query param wins: it is the host's theme at the moment the surface opened.
A malformed value on either route is ignored — a bad theme must never blank the
app. Both flow through `themeCssVariables`, the same flattening the chrome and
the jail use, onto the `--vendo-*` custom properties the Kit's tokens read.

## The files

| File | What |
| --- | --- |
| `src/App.tsx` | **the app — this is the file to edit** |
| `src/main.tsx` | the wiring: brand, provider, frame protocol. Rarely touched |
| `src/provision.ts` | the page half of the provision contract |
| `src/fn.ts` | `callFn` — the app's own server half |
| `fns.js` | the `POST /fn/<name>` handlers |
| `server.js` | the skin contract + serving the Vite build |
| `provision.mjs` | the disk half of the provision contract |
| `vendo.json` | the manifest (`schedules`, `egress`) |
| `run` | the `.vendo/run` line, landed by the bake |
