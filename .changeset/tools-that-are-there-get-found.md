---
"@vendoai/actions": patch
"@vendoai/agents": patch
---

Two ways a host with a full `.vendo/tools.json` still got an agent that could do nothing.

`api()` promised defaults its own JSDoc and the umbrella already documented — the working directory for `dir`, `VENDO_BASE_URL` for `baseUrl` — and forwarded neither. A backend writing `agent({ tools: [api()] })`, exactly the shape the docs show, handed `createActions` no directory at all, so no `.vendo` file was ever read and the agent booted with zero host tools. Both defaults now apply where the promise was made, in `api()`; `createActions` still defaults nothing, because the doctor probes pass `dir: undefined` on purpose to strip the file reads. The errors a baseUrl-less route or tRPC call throws named `createActions({ baseUrl })`, an internal a backend holding `api()` never calls; they name `VENDO_BASE_URL`, or passing `baseUrl`, now.

`vendo sync` run through `npx` extracted nothing and blamed the routes for it. Two of the three TypeScript loaders resolved the compiler only from vendo's own install, and under `npx` that directory cannot see the project's `typescript` — so module parsing returned null, every route came back "no supported exported HTTP verb", and the warning pointed at the route files instead of the missing compiler. All three loaders share one ladder now: the project being synced first, this install second. The report's compiler warning covers "no compiler resolved at all" alongside the too-old case it already named.
