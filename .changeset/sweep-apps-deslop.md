---
"@vendoai/apps": patch
---

Box door: a session that fails to open now hands its in-flight slot back, so a
box whose SDK import fails answers 500 once instead of 409 "a message is
already running" forever.

fn names: one bounded `[A-Za-z_][A-Za-z0-9_-]{0,63}` pattern instead of two that
disagreed, so a long fn name no longer dispatches in-process while the HTTP wire
route refuses it.

Review queue: each app's rejection rows are paged once per queue build, not
twice.

Removed two surfaces with no callers: `explicitSamplingParams` /
`SamplingRequest` (never on any export path) and `EgressApprovals.pending`.
