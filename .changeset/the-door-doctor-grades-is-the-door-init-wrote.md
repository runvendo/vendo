---
"@vendoai/vendo": patch
---

E-MCP-009 grades the door init actually wrote. The composition moved into its own
module (`lib/vendo.ts`, `src/lib/vendo.ts` under a src layout) and doctor's MCP
path list never followed, so on every host init scaffolded since then the check
found no composition at all and said NOTHING — no failure, no check, nothing to
notice — which is the precise outcome a hard FAIL exists to prevent: a door whose
discovery advertises the wrong origin, surfacing hours later in someone else's
terminal as "Claude can't find my server". The list now leads with the current
module and keeps every legacy location (the route's sibling `vendo.ts`, the inline
route, the Express and runtime-neutral modules), in the same order
`doctor-wiring-checks.ts` reads them, so older installs grade exactly as they did.

Expect the intended failure to reappear: an MCP-wired host with neither
`VENDO_BASE_URL` nor `mcp: { baseUrl }` fails E-MCP-009 and exits 1, where it had
been silently green. Interactive `vendo init` now answers it in dev by writing the
dev origin to `.env.local`; production sets the variable where it deploys.
