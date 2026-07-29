---
"@vendoai/vendo": patch
---

Three CLI help and error lines now say what the code actually does.

`--yes` claimed only "skip the cloud-login offer". It also accepts the detected
auth preset, skips the AI polish pass and the theme review, and swaps the
interactive success screen for the agent tail — an agent reading the old line
could not predict any of that. `--framework` listed `next, express` while
`custom` (the runtime-neutral scaffold for Workers, Bun, Deno, Hono, and Lambda
adapters) has been accepted all along.

When `vendo login` dies on a transient failure — network, DNS, a killed fetch —
it printed the raw error and nothing else, so the reader assumed the ceremony
was lost and started over, abandoning an approval that would still have landed.
It now names the surviving pairing code and says that re-running `vendo login`
resumes the same request. The line appears only when a resume can actually
succeed: every terminal outcome already deletes the claim.
