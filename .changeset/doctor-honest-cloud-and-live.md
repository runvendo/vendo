---
"@vendoai/vendo": patch
---

Three doctor honesty fixes for real-world deployments. Console-managed deployments stop failing E-CFG-001: with `VENDO_API_KEY` set, a missing cloud-resolvable surface (`brief.md`, `policy.json`, `theme.json`, `overrides.json`) is a warning pointing at `vendo config status` — those surfaces legitimately live as published config (`tools.json` stays fatal; keyless behavior is unchanged). E-LIVE-001 now carries what actually came back from `/status` — the wire's own `error.code`/`error.message` plus a dev-server-log hint — and an answered non-JSON error page is reported as E-LIVE-001 with its HTTP status instead of being mislabeled "unreachable" (E-LIVE-002 is reserved for a fetch that never answered). And every `fix_ref` URL now points at `docs.vendo.run/agents/verify`, which serves the playbook directly instead of a redirect some agent HTTP clients refuse.
