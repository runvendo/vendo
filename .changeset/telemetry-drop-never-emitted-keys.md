---
"@vendoai/telemetry": major
---

**BREAKING:** drop the `extract_completed` event and five cloud prop keys
(`connectionsConfigured`, `toolkitsEnabled`, `servedApps`,
`experimentalFlags`, `componentsMs`) from the allowlists, and remove `try`
from the `command_run` command enum.

None of these were ever emitted — no producer existed anywhere in the tree —
so TELEMETRY.md was over-declaring what Vendo collects. The disclosure now
matches what is actually sent. `EventName` no longer includes
`extract_completed`.
