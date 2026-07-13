# Cross-Block Integration Suite (fixtures/integration) — Wave Plan

**Goal:** A permanent, CI-required integration suite that boots the REAL composed
umbrella (`createVendo` from `@vendoai/vendo`) against the fixture host app and
drives whole-product user journeys end-to-end through the public wire and hooks,
asserting real side effects. Wave-4 and composition each found latent bugs that
block-local tests missed (5 and 8 respectively); this suite makes that class of
bug a standing CI catch instead of a per-wave discovery.

**Why this is different from every existing fixture suite:** chat-e2e,
automations-e2e, mcp-e2e, and redteam all compose blocks BY HAND ("the way the
umbrella will compose them"). Nothing on main tests the actual composition —
`createVendo` + its wire — with the blocks unstubbed. `packages/vendo/server.test.ts`
stubs block methods (routing coverage) and runs exactly one real chat turn.

**Scope discipline:** additive only — `fixtures/integration` + a CI job. Frozen
contracts (docs/contracts) are law and are NOT modified. Real cross-block bugs
found by the suite are fixed in the owning block, each with a permanent
regression test here.

---

## Design decisions (locked)

1. **The composition under test is `createVendo` itself.** No hand-wiring of
   store/guard/actions/apps/automations in the harness. The harness passes only
   what a real host passes: model, principal resolver, store (temp-dir PGlite for
   isolation), actAs, policy.
2. **Host tools load through the real `.vendo/` contract.** The fixture package
   commits `.vendo/tools.json` (`vendo/tools@1`, route bindings against the
   fixture host app) and a `.vendo/policy.json`. `createVendo` reads them from
   cwd via `createActions({dir: "."})` — a load path no composed test exercises
   today. `VENDO_BASE_URL` points route bindings at the booted host app
   (trusted-origin branch).
3. **Journeys drive real HTTP.** The umbrella handler is served on a loopback
   `node:http` server (adapter pattern already proven in fixtures/mcp-e2e);
   tests hit it with `fetch`/SSE — the public wire, not `handler()` in-process
   shortcuts. Side-effect asserts: raw SQL on the public `vendo_*` tables
   (02 §table-map is contract), host-app HTTP state, and wire GETs.
4. **Deterministic model, zero live keys in CI.** The chat-e2e `scriptedModel`
   pattern (`MockLanguageModelV3` from `ai/test`) drives both agent turns and the
   apps generation engine (which consumes the same `LanguageModel` via
   `generateText`). Generation turns return the CREATE/EDIT dialect JSON shapes
   from `packages/apps/src/engine.ts`.
5. **MCP door composes around the umbrella the way a host must today.** The
   `createVendo({mcp:true})` hookup (docs/contracts/10-mcp-umbrella-hookup.md) is
   an unlanded handoff gated on a Yousef naming decision, so the suite mounts
   `createMcpDoor` beside `vendo.handler` on the same loopback origin, fed from
   the umbrella's own composed parts (guard-bound registry, guard, store,
   AppsPort over `vendo.apps`). When the hookup lands, the harness collapses to
   the one flag and the journeys stay valid.
6. **UI journey = real browser.** A minimal Vite harness page mounts
   `VendoRoot`/hooks (`useVendoThread`, `useApprovals`, `useApps`) proxying
   `/api/vendo` to the loopback wire server; Playwright Chromium drives it
   (pattern proven in packages/ui/playwright.config.ts: ephemeral port,
   workers 1, retries 0). Chat send → approval card → decide → side effect.
7. **Flake discipline is a merge gate.** `fileParallelism: false`, generous
   suite timeouts per the CI-hardened fixture patterns, no test retries. The
   full suite must pass ≥5 consecutive full runs locally before the PR merges.
8. **CI job.** A dedicated `integration` job in `.github/workflows/ci.yml`
   (install → turbo-scoped build of deps → run the suite; Playwright Chromium
   installed for the browser leg). The suite also runs inside the existing
   `ci` job via root `pnpm test` (fixtures are workspace members); the dedicated
   job gives it a required named check. Branch-protection required-check added
   if API permissions allow, else flagged to Yousef.

## The journeys (each = one permanent regression test file)

- **J1 chat-generates-app:** POST /threads turn → scripted agent calls the
  `vendo_apps_create` capability tool → generation returns a valid
  `vendo-genui/v1` tree → SSE completes → `vendo_apps` row (SQL), GET /apps,
  GET /apps/:id/open returns the tree payload.
- **J2 destructive approval round-trip:** chat turn calls a destructive host
  tool → decision pipeline parks it → GET /approvals shows `inputPreview` →
  POST /approvals/decide (approve + remember) → resumption executes the real
  HTTP call against the host app → host state changed, audit rows, grant row
  minted; a second turn runs grant-authorized without asking.
- **J3 app edit + history:** POST /apps/:id/edit with scripted EDIT-dialect
  response → EditResult; history lists two versions; POST history undo restores.
- **J4 automation lifecycle:** automation app enters through the public wire
  (POST /apps/import of a built .vendoapp with a trigger — fresh id minted) →
  POST /automations/:id/enable → `{enabled, missing}` → decide approvals →
  standing app-bound `source:"automation"` grants (SQL) → fire the trigger both
  ways that are public (POST /tick with bearer for schedule; `vendo.emit` for
  host-event) → away run executes steps against the host app via `actAs` →
  GET /runs shows ok with steps, host side effect real.
- **J5 away-run grant capture + park + revoke:** away step on an ungranted tool
  parks the run `pending-approval` (fails soft) → approval queues → decide →
  run resumes ok. DELETE /grants/:id → next firing parks again (revocation is
  live). Chat-minted grants must NOT authorize away (05 §6) — asserted through
  the composed wire, not block-local.
- **J6 MCP door round-trip:** real MCP SDK client: 401 → WWW-Authenticate →
  path-inserted metadata discovery → OAuth (fixture HostOAuthAdapter over the
  host app's login) → initialize → tools/list (descriptors = bound registry
  verbatim) → tools/call (read runs; destructive returns in-band isError naming
  the approval) → SQL: `venue='mcp'` audit + door-auth events. Apps ride-along:
  `vendo_apps_open` returns the J1-style app's payload with the ui `_meta`.
- **J7 UI hooks in a real browser:** VendoRoot page → useVendoThread send →
  stream renders → useApprovals surfaces the parked call → decide in-page →
  host side effect; useApps lists the generated app.

## Execution (per hardening-execution-model.md)

Fable orchestrates; ALL implementation on Claude Opus subagent lanes (or Codex
lanes) — never Fable. Orchestrator runs installs, stages, commits, gates.

- **Lane A (first):** package scaffold, `.vendo/` files, global-setup (host-app
  boot with own FIXTURE_DIST_DIR + wire server helper), scripted-model support,
  J1 + J2 + J3.
- **Lane B (after A):** J4 + J5 + J6.
- **Lane C (after A, parallel with B):** J7 browser leg + CI workflow job.
- **Bug-fix lanes:** any real cross-block bug → fix in the owning block +
  regression test in this suite. Contracts stay frozen.
- **Verification:** root gates green; new suite ≥5 consecutive green full runs;
  Codex review + adversarial self-pass; external reviewers triaged; PR to main
  (baseRefName=main); autonomous merge on the full done-definition.

## Non-goals

- No `createVendo({mcp:true})` hookup (Yousef-gated naming decision; flagged).
- No live-model legs (existing env-gated live suites already cover those).
- No re-proving block-local behavior already pinned by chat-e2e /
  automations-e2e / mcp-e2e / redteam — this suite owns the *composed* system.
