# Maple Vendo catalog

This directory follows the frozen host-side contract in 09-vendo.md:

- tools.json is the generated vendo/tools@1 host API catalog.
- overrides.json is the human-owned vendo/overrides@1 overlay.
- policy.json is the deployed vendo/policy@1 guard policy.
- brief.md is Maple context for the agent.
- theme.json is the frozen VendoTheme consumed by the React provider.
- data/ is local store state and is gitignored.

Run vendo sync after changing the host API.
