---
"@vendoai/apps": major
"@vendoai/vendo": major
---

A served app is reached through one checked door, and `experimentalServedApps` is
gone.

**The flip.** `open()` on a served (layer-3) app answered the OWNER with the
sandbox provider's raw public ingress URL, and only a non-owner with this
deployment's authenticated proxy URL. That owner URL is a bearer-by-obscurity
capability: it carries no per-request check, so it keeps working for anyone it
reaches — a shared screen, a copied link, a log line, a pasted bug report — and it
outlives the grant, the revoke, and the app. Every served app is now answered with
the proxy URL, which re-checks `can(viewer)` against live rows on every request
and wakes the machine only after that check passes. The provider-URL leg is
deleted, not left standing: there is no second way to reach a served app.

Theme parity is kept — the proxy forwards `?vendoTheme=` into the box, so a served
app renders in the host's brand exactly as before.

**BREAKING: `AppsConfig.experimentalServedApps` and `apps.experimentalServedApps`
are removed.** Layer 3 was never a capability a flag could grant on its own: it is
a narrowing of layer 2. Delete the option — a host that passes it now fails to
typecheck. `experimentalMachines` is unchanged and still required.

What gates a served app instead, all of it already load-bearing:

- **A machine to serve it.** `served` is derived as a narrowing of `box` in
  `laneGates`, so no sandbox or no `experimentalMachines` means no served lane —
  the relationship is the shape of the expression rather than two flags that have
  to agree with each other at composition time.
- **A door to serve it through.** `laneGates` also requires `servedProxyPath`, so
  a deployment whose wire is not mounted hears "this host cannot serve its own web
  pages for an app" as a plain `<Cannot>` line in the plan, before a machine is
  built and a surface flipped to something no caller can open. The umbrella fills
  that seam from its own base path, so a `createVendo()` host has it already.
- **An absolute origin.** The proxy URL must be absolute for a caller that is not
  already on this origin, so serving an app needs `VENDO_BASE_URL` — the same
  variable machine provisioning already requires.
- **The surface flip's own two signals**, untouched: the plan asked to be served,
  and the host itself fetched `GET /` and got a real page. A box that self-declares
  a served surface on a layer-2 plan is still refused, loudly, and the tree keeps
  serving.
- **Permission, first.** `edit()` on a served app no longer carries a flag
  refusal; what comes first is `can(editor)`, and an already-provisioned machine is
  never gated by the layer-2 flag — only new graduation and provisioning are.

Removed with it: `servedAppsDisabledError`, the `servedThroughProxy` predicate
(and the duplicate access read it did behind `open()`'s own check), the
`ServedSurface.enabled` mirror, and the composition-time
`experimentalServedApps requires experimentalMachines` refusal — six concepts out,
one expression in.
