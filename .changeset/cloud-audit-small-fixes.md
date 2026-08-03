---
"@vendoai/vendo": patch
"@vendoai/automations": patch
---

Cloud-audit small fixes: five places where the runtime and what it claims had
drifted apart.

**The hosted session sweep now rides the authenticated tick.** Both existing
cadences are unreachable on a serverless host — the unref'd interval timer
never fires, and the amortized on-request sweep is gated by a per-process
`lastSweepAt` that a per-request process re-seeds every invocation. A
deployment on the hosted store leaked idle anonymous sessions forever.
`POST /api/vendo/tick` now runs the same sweep the other two cadences call
(hosted stores only; a local composition already has both). Two cadences
firing at once is safe — the claim leg is a single-winner election
server-side.

**`E2B_API_KEY` without the `e2b` package is now a loud misconfig.**
`createVendo` used to silently demote a half-configured BYO sandbox to Cloud,
or to the dark venue with no key at all, so the operator found out at the
first server-app build. It now throws with the exact fix. An explicitly
passed `sandbox:` adapter still wins before any env check.

**`fn:` steps deferred to Cloud now warn.** Enabling an automation whose
schedule or external trigger fires on Cloud, with `fn:` steps in it, warns
once naming the app: `fn:` runs in the app's own sandbox machine, which the
Cloud runner may not be able to wake or reach in v1. The docs claimed this
warning existed and described `fn:` as a callback into the host process —
both wrong, both fixed.

**Two honesty fixes to operator copy.** `vendo doctor` no longer offers a
"managed MCP broker" no code path wires from a key; it names the adapter slots
a key actually defaults. And the hosted-session-doors warning no longer blames
a vendo-web commit for a surface the console restored on 2026-07-20 — it
reports what the client observed (a bare 404) instead.
