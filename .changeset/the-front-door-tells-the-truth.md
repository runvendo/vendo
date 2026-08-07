---
"@vendoai/vendo": patch
---

Fourteen correctness fixes on the umbrella — the package hosts actually install.

Two of them touch what leaves a machine. Pinning `VENDO_DEV_CREDENTIAL=vendo-cloud`
without a `VENDO_API_KEY` used to return the cloud rung anyway, and the gateway call
was then made with `apiKey: undefined` — `@ai-sdk/anthropic` falls back to
`process.env.ANTHROPIC_API_KEY`, so the host's own provider key was sent to
console.vendo.run. The pin now degrades to `none`, which is what the docs already
promised. And composing a Vendo minted a persistent, opted-in telemetry id into
`~/.vendo/telemetry.json` on first boot, whether or not telemetry was ever enabled and
whether or not anything could ever be uploaded; that identity is now read only when the
Cloud slot is filled, and local-only capability misses carry no identity at all.

The served-app proxy rebuilt its forwarded path from percent-decoded segments, so an
encoded `/` or `?` in a URL turned into a real separator inside the box's request. A
host pointing `profileDir` at its own `.vendo` directory silently lost theme, brief,
catalog, knowledge and its pin baselines. `vendo sync` answered "no saved references"
for tools that live generated app code calls, because it never read the compiler's
`componentTools` manifest. A repeated tool name from the console took down the host's
entire tool registry. The vendo verbs flattened their own written-for-the-model refusals
("this app has no schedule to change — ask for the automation first") into "could not
complete, try again".

On the CLI: `vendo doctor` failed every Pages-Router host forever and told it to edit a
file that does not exist — it and `vendo init` now share one answer for where the mount
belongs. Doctor also hung for up to two minutes after printing its verdict when the dev
server failed to spawn. Theme extraction let an `@import`ed stylesheet override the
sheet that imported it, reporting the wrong brand colour as an exact read. The judge
discarded its best-evidenced grades as "no evidence" when the quote ran long, and could
not repair the commonest truncation of all. `vendo init` ran a package install on
workspaces that already had the dependency hoisted, and pointed users at a docs path
that only exists inside this repo. Auth0 tenants configured with a trailing slash could
not log in at all.
