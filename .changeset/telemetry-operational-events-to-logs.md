---
"@vendoai/telemetry": minor
---

Send the operational events — `doctor_run`, `command_run`, `agent_run` — to PostHog's Logs product instead of the product-analytics stream, so a record of "this ran" lands in a store with enforced 30-day retention rather than being kept indefinitely. Same project key, same allowlist, same scrubbing, same opt-outs, same `VENDO_POSTHOG_HOST` override; only the destination and the retention change, and no event is sent to both. `init_started`, `init_completed`, `init_failed`, `star_prompt` and `error_class` are unchanged.
