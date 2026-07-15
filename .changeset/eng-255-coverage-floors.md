---
"@vendoai/core": patch
---

Test hardening (ENG-255): wire v8 coverage across every package with a ratcheted
per-package line-coverage floor enforced in CI (`pnpm test:coverage`), remove
`--passWithNoTests` so empty suites fail, add dedicated unit tests for the
thin/zero-test hot paths (core schemas + component-map, agent prompt, store
run/audit helpers, automations engine), and add cross-block journeys J8 (actions
OpenAPI sync callable over the wire), J9 (Postgres durability + restart drill),
J10 (multi-tenant concurrency isolation), and J11 (telemetry allowlist wire).
No runtime behavior changes.
