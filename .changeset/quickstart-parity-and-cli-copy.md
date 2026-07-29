---
"@vendoai/vendo": patch
---

`vendo init --yes` no longer blocks on the loosening review, and three CLI help
and error lines now say what the code actually does.

`--yes` promises every question is already answered. It kept that promise for
the AI-polish consent and broke it one step later: with `--ai-polish` granting
consent, a run in a terminal reached the aggregated loosening review and waited
for a human the moment the judgment pass proposed waking a disabled tool or
lowering a risk grade — so `vendo init --yes --ai-polish` could hang in CI or
under an agent. Unattended runs now queue loosenings instead: held as `pending`,
nothing applied, printed with `vendo sync --review`. Auto-applying was never an
option — risk is not lowered without a human — and no `confirm` seam is handed
to the pass at all when the run is unattended, so nothing downstream can block
either.

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
