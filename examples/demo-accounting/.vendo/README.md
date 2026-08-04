# Cadence Vendo catalog

This directory follows the frozen host-side contract in 09-vendo.md:

- tools.json is the generated vendo/tools@1 host API catalog.
- overrides.json is the human-owned vendo/overrides@1 overlay.
- policy.json is the deployed vendo/policy@1 guard policy.
- brief.md is Cadence context for the agent.
- theme.json is the frozen VendoTheme consumed by the React provider.
- data/ is local store state and is gitignored.

Run vendo sync after changing the host API.

## Why overrides.json regrades audience to end-user

The AI judge graded the firm-data tools `audience: operator`, which fail-closes
them to disabled. That grade conflated firm staff with product operator:
Cadence's end users ARE firm staff (it is an accounting product FOR accounting
firms), so the human layer re-grades those nine tools `end-user` and wakes
them (`disabled: false` — the audience fail-close is applied at the judgment
layer, before overrides). Risk and confirmEach grades are untouched.
