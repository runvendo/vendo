---
"@vendoai/vendo": patch
---

`vendo sync`'s ◇ Impact probe now resolves the wire URL through the SAME env the flow already merged before giving up on the hardcoded `localhost:3000` default: `VENDO_URL` outright, else `VENDO_BASE_URL` joined with `/api/vendo` (whose path prefix is exactly the mount the wire hangs off). On any host served under a base path — the flagship demo-bank at `/maple` included — Impact was dead by default, reporting "dev server not reachable" against a URL the dev server never served; now the value init wrote makes the probe work with no new flags. When the probe fails with no URL resolved from the flag, the env, or the dotenv, the note now names the variable that would fix it — and stays quiet about variables the run already used.