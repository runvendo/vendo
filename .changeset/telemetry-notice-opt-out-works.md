---
"@vendoai/telemetry": patch
---

The first-run telemetry notice advertises an opt-out that exists.

The one-time consent notice told every new user "disable now: `vendo telemetry
disable`". No such command has ever existed — the CLI has no `telemetry`
branch, and the only occurrence of that string anywhere in the repo was the
notice itself — so the single actionable instruction in the privacy notice
failed with an unknown-command error. It now names `VENDO_TELEMETRY_DISABLED=1`,
which the very next line already listed and which TELEMETRY.md has documented
all along.

The test that covers the notice now checks every environment variable the
notice names is one `envOptOut` actually honors, and that the notice names no
`vendo …` command at all: this package deliberately depends on no `@vendoai`
package, so it can never verify that a CLI command exists.
