---
"@vendoai/apps": minor
---

Secrets egress fetch shim (ENG-290 M4, 06-apps §4.3/§4.5 option B).

- **In-sandbox fetch shim**: every machine now carries a runtime-owned
  `/app/.vendo/fetch-shim.cjs`, loaded at boot via `NODE_OPTIONS --require` by
  the rung-2/3 boot convention, the rung-4 served-app scaffold's `start.sh`,
  and Modal's create command. Outbound `fetch(externalUrl)` from app code is
  rewritten into `POST {VENDO_PROXY_URL}/egress` authenticated by the run
  token, so plain `fetch` with a declared secret handle in a header or body
  authenticates to allowlisted hosts — substitution stays exclusively at the
  proxy, outside the sandbox. Internal requests (relative URLs, the proxy
  itself, loopback) are never rewritten; a refused egress surfaces as an
  ordinary fetch `TypeError`, never a leak.
- **Interchange**: `.vendoapp` exports exclude the runtime-owned shim, and
  imports rebuild machines with the current shim (an archive can never smuggle
  a modified one in).
- Env-gated live lanes prove the shim on real E2B (Modal lane parked on
  missing `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`, exactly like the ladder
  lanes).
