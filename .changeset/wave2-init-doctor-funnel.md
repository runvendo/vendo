---
"@vendoai/vendo": patch
---

Install-funnel fixes from the 0.4.x E2E certification (Wave 2):

- **Visible surface (B3).** `vendo init` now generates a `"use client"` mount
  wrapper (`vendo/vendo-root.tsx`) that applies the registry + theme and
  mounts `<VendoOverlay />`, and wires it into the Next.js layout with one
  bounded, idempotent edit (skipped when a Vendo mount already exists;
  degraded to printed paste lines when the layout has no single unambiguous
  `{children}`). The wrapper is the RSC-safe home for the registry import —
  the previously printed registry-in-server-layout paste crashed every page.
  `VendoOverlay` is re-exported from `@vendoai/vendo/react` so the scaffold
  resolves under pnpm strict linking.
- **Principal alignment (B4).** The anonymous scaffold's wire principal now
  resolves the same demo subject the existing-agents quickstart chat routes
  set (`demo-user`) instead of `null`, so apps and approvals created through
  a BYO agent loop are visible to the embeds. `GET /apps/:id/open?pending=1`
  now distinguishes a record that exists under another principal (terminal
  `{kind:"failed"}` with the mismatch diagnosis) from a still-building app
  (`{kind:"pending"}`) — no more infinite skeleton.
- **Doctor honesty.** New E-WIRE-006 check fails when no visible surface is
  mounted anywhere; new E-LIVE-006 render gate GETs the app root and fails on
  a 5xx; new E-DEP-002 fails when the running wire's `/status` version
  disagrees with the CLI's (split-brain installs where a direct
  `@vendoai/vendo` pin beats the `vendoai` umbrella); E-WIRE-004 now accepts
  a `<VendoRoot>` mount in ANY app layout (not just the root one); the
  unreachable-`/status` copy names the wire base `--url` expects; the probe
  dev-server's pipes are destroyed on stop so doctor's exit code always
  lands.
- **Login write-preflight (M4).** `vendo login` proves `.env.local` is
  writable before opening (or resuming) a claim — a sandboxed run that cannot
  write the file fails up front instead of consuming the single-use claim and
  losing the minted key — and a redemption-time write failure now reads as a
  distinct write error (revoke + retry) instead of the timeout copy.
