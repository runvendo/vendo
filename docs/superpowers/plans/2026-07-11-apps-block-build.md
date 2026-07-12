# @vendoai/apps — Wave-3 Block Build Plan

> **For agentic workers:** Fable orchestrates; Codex implements via `codex exec` lanes. Fable reviews diffs, stages, commits. Contracts are FROZEN — `docs/contracts/06-apps.md` (block), `01-core.md` (shapes), `docs/superpowers/specs/2026-07-11-app-format-design.md` (format authority). Old code in `legacy/` is a read-only quarry; never imported.

**Goal:** Build `packages/apps` (`@vendoai/apps`) fresh against the frozen contract: app lifecycle, edit loop, ladder + invisible graduation, generation engine, SandboxAdapter seam + e2b/modal adapters, the server execution contract, pins, `.vendoapp` interchange, and `agentTools()` — with an e2e test suite through the public surface only.

**Architecture:** One package, `@vendoai/core` as its only workspace dependency (dependency-guard enforced). `ai` is a type-only peer for the `LanguageModel` generation seam. Persistence goes exclusively through the core `StoreAdapter` seam; sandbox execution through the `SandboxAdapter` seam defined here. Tests run against an in-process fake `SandboxMachine` that is a real HTTP handler, a conformant in-memory `StoreAdapter`, and a real guard-binding chokepoint fixture (05 §2 semantics). Live LLM / live-sandbox tests are env-key-gated; CI runs deterministic doubles.

**Tech stack:** TypeScript (ESM, NodeNext), zod, `fflate` (zip for `.vendoapp`), vitest, `ai` (peer; `ai/test` mock models in dev). WebCrypto only — no Node-specific APIs in src.

---

## Decisions (made planning this block; each flagged in the PR)

1. **App-row persistence convention.** Apps may import only core, so it cannot use `@vendoai/store`'s typed helpers. App documents persist via `store.records("vendo_apps")` — record id = `AppId`, `data` = the document, `refs.subject` = owner. Per-user `state` singleton via `records("vendo_state")`, id `<appId>:<subject>`. Version history (runtime UX, capped) via `records("vendo:app-history:<appId>")`. The store block routes reserved collections to dedicated tables; coordinated at umbrella time.
2. **Rung-4 URL gap.** `OpenSurface {kind:"http"}` needs a URL but the frozen `SandboxMachine` has none. Resolution: optional additive capability `url?(port): Promise<string>` on machines (same pattern as optional `screenshot?`). Fake + e2b + modal implement it; a machine without it can't serve rung 4 (`sandbox-unavailable`).
3. **Tool-proxy mounting gap.** `VENDO_PROXY_URL` must be injected into machines, but the runtime can't know its public URL and nothing mounts the proxy. Resolution: additive config `proxyUrl?: string` + `AppsRuntime.proxy.handler(req: Request): Promise<Response>` for the umbrella to mount. No proxyUrl → machines run without host-tool access (documented).
4. **Pin baselines access.** Export gating needs `PinBaseline.exportable` (captured by sync into `.vendo/remixable/`). Resolution: additive config `pinBaselines?: PinBaseline[]`. A pinned app whose baseline is absent or non-exportable fails export (never strips).
5. **Run token.** `VENDO_RUN_TOKEN` = HMAC-signed (WebCrypto) compact token minted per run over `{appId, principal, runId, presence}`, short-lived, verified by the proxy handler in-memory. Not persisted.
6. **share/publish.** No `VENDO_API_KEY` → `VendoError("cloud-required")`. Key present → `not-implemented` (cloud client ships separately); shapes exported.
7. **Generation v0 is non-streaming** at the public API (`create`/`edit` return promises, as contracted). Streaming/partial-tree rendering is the agent-stream/ui plane; engine internals leave room.
8. **Zip via `fflate`** — pure JS, platform-neutral, tiny. Only runtime dep besides zod.

## Lanes (Codex implements; sequential commits, parallel only on disjoint dirs)

### Lane A — scaffold + test fixtures
- Package scaffold: package.json (exports `.`, `./e2b`, `./modal`), tsconfig, vitest config, wired into the turbo workspace. Dependency-guard passes.
- Test fixtures under `test/fixtures/`: in-memory conformant `StoreAdapter`; fake `SandboxAdapter`/`SandboxMachine` whose `request()` dispatches into a real in-process HTTP-handler "machine app" (programmable per test: `/fn/*` handlers, echo of env/headers); a guard fixture implementing core `Guard` + a `bind()` chokepoint with 05 §2 semantics (critical→ask, grant match, default run; records audit; supports parking + `onApprovalDecision`).
- Checkpoint: build + typecheck green; fixtures have their own smoke tests.

### Lane B — lifecycle + app data + history
- `createApps()` config surface incl. decisions 3–4; `create` (stub engine until Lane D: minimal named empty-tree document), `get`, `list`, `delete`, `fork` (fresh id, `forkedFrom`, deep-copied doc, no data/grants copied), ownership scoping by `ctx.principal.subject`, `not-found` semantics.
- App data plumbing: storage declarations → `app:<appId>:<name>` collections; `state` singleton get/set; files-kind → blobs.
- `history()` capped log (append per edit; `undo` restores previous document version); `VersionEntry` shape.
- Audit: lifecycle events via `guard.report` (kind `app-lifecycle`).
- e2e tests: full lifecycle through `AppsRuntime` only; spec §1 document example validates and round-trips through create-shape.

### Lane C — execution: open/call, run env, tool proxy, secrets handles
- `open()`: rung 1–3 → `{kind:"tree", payload, components}` resolving `TreeQuery`s (tool names through the bound registry; `fn:` refs through the machine); rung 4 → resume snapshot, `{kind:"http", url}`, `{kind:"resuming", cover}` while waking; always answers from last state (invisible graduation).
- `call()`: `fn:<name>` → `POST /fn/<name>` on the machine, `{result}` | `{ui}` envelope (explicit key, never body-sniffing; `{ui}` validated as `UIPayload`, rung-3 path), machine errors → contained `ToolOutcome` error; tool names → bound registry pass-through.
- Machine boot: env injection (`PORT`, `VENDO_PROXY_URL`, `VENDO_RUN_TOKEN`, secret handles `vendo-secret:<name>:<nonce>`), snapshot lifecycle (create → snapshot → `server` field; resume by prefixed ref).
- Tool proxy handler: `POST /tools/<name>` with bearer run token → resolve `RunContext` → bound registry → `ToolOutcome` verbatim (incl. `pending-approval` fail-soft); `vendo.state` get/set endpoints.
- Egress substitution module: handle→value substitution against the `egress` allowlist (used by adapters; unit of the security rule "app code never sees values").
- e2e tests: fn call round-trip; rung-3 `{ui}` envelope renders as tree surface; tool-proxy round-trip through the real guard-binding fixture (run, ask→park, blocked); away+ungranted → `pending-approval` tolerated; secrets: machine env holds handles, never values; egress substitution only toward allowlisted domains.

### Lane D — generation engine + agentTools
- Engine: prompt stacks (tree emission from prompt+catalog+theme+designRules+format caps; edit = tree-ops dialect validated against catalog, code-hunk dialect syntax-checked) — engine internals, not public API. `create`/`edit` public entries; `EditResult` with `issues`; escalation builds in a fork and swaps on success (previous rung keeps serving); host components preferred when catalog covers the need.
- `agentTools()`: `vendo_apps_create` / `vendo_apps_edit` / `vendo_apps_open` as a core `ToolRegistry` with JSON-Schema inputs (provider-safe names).
- Tests: scripted `LanguageModel` (ai/test) — deterministic tree/edit outputs; invalid-model-output → contained validation issues, never a broken shipped tree; live-LLM test gated on `ANTHROPIC_API_KEY`; agentTools e2e through a guard binding.

### Lane E — interchange + pins
- `exportApp`: `.vendoapp` zip = `app.json` + `app/` from snapshot when a server exists; no data/caches/grants/snapshots. Pin gating per decision 4 — export FAILS on forbidden pin.
- `importApp` (bytes or document): validate (`validateAppDocument`), mint fresh `AppId` (never trust artifact ids), empty data, no grants; `app/` present → create machine → write files → snapshot → `server`.
- `share`/`publish` per decision 6; pins shapes (`PinBaseline`, `PinShipRequest`, `PinApproval`, `InClientApproval`) + zod schemas.
- e2e tests: export→import round-trip (fresh id, no data leakage, machine rebuilt through fake adapter); export-denied-pin failure; import of spec §1 example document; malformed archive → `validation`.

### Lane F — e2b + modal adapters
- `@vendoai/apps/e2b` (`e2bSandbox({apiKey})`), `@vendoai/apps/modal` (`modalSandbox({tokenId, tokenSecret})`) implementing the seam incl. `url?()`; provider-prefixed snapshot refs (`e2b:…`, `modal:…`). Research current SDKs (context7/web) before implementing.
- Live tests gated on `E2B_API_KEY` / `MODAL_TOKEN_ID`+`MODAL_TOKEN_SECRET`; CI: adapter unit tests with mocked SDK transport + the same adapter-interface conformance suite the fake passes.

### Lane G — conformance + polish
- Run core's conformance kit (`@vendoai/core/conformance`) for every seam consumed/implemented once the core lane fills it (re-merge core branch; kit is a stub today).
- Docs: package README (public surface, run env table, conventions, gaps flagged); update `docs/contracts` NOT touched (frozen).
- Root gates: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green.

## Review + delivery
1. Codex review pass over the full diff (fresh `codex exec` reviewer lane).
2. Fable adversarial pass (contract-line-by-line audit: every 06 normative sentence has a test or a documented gap).
3. One PR to main; body lists the four contract gaps + decisions above; Orca worktree comment updated at each lane checkpoint. Only Yousef merges.

## Re-merge cadence
Merge `origin/yousefh409/v0-wave3-core` before each lane dispatch and before the PR; rerun conformance after each merge.
