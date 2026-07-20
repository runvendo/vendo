# Route-Scan Schema Inference Implementation Plan (PR 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route-bound tools stop shipping blank input schemas wherever the handler's body/query shape is statically knowable, per the approved spec's PR-2 section.

**Architecture:** A new collectors module (`route-schema.ts`) is asked once per route at route-scan's single emission point. Collector order per the spec: zod-in-handler first (reuses the oracle-hardened `zodFromExpression`), then the TypeScript-checker collector (one lazily built program per scan, host-resolved compiler), with the query collector merging additively into either result. Everything fails closed to today's exact output.

**Tech Stack:** TypeScript compiler API (host-resolved, per `static-ts.ts` conventions), vitest, existing corpus harness for real-world verification.

**Spec:** `docs/superpowers/specs/2026-07-19-route-scan-inference-and-zod-oracle-design.md` (PR-2 section; decisions locked: both collectors, body + query, extend route-scan in place).

**Branch/PR:** `yousefh409/route-scan-inference` off main @ 49f3f40f; PR into main when green.

**Context an implementer needs (verified against current main):**
- Emission point: `packages/actions/src/sync/route-scan.ts` — `scanRoutes` (~line 416) loops routes, resolves verbs via `verbsFromSource`, and pushes one tool per method with `inputSchema: routeInputSchema(route.urlPath)` (path params only) and `argsIn` chosen by method (GET/DELETE → query, else body).
- The zod reader: `zodFromExpression(extraction, module, expr, depth)` in `packages/actions/src/sync/static-ts.ts`, differential-tested by `static-ts.oracle.test.ts` (48 rows). Identifier resolution across files: `resolveIdentifier`; module parsing: `parseModule`; host compiler loading (fail-closed null): `loadTypescript`.
- Fail-closed conventions: partial recognition carries a `reason`; unknown shapes → permissive schema plus a `note` on the tool (see how tRPC/server-actions do it).
- The tRPC extractor (`trpc.ts`) is the reference for a `StaticExtraction`-threaded, compiler-based extractor; server-actions (`server-actions.ts`) for handling annotations.

---

### Task 1: The collector seam (zero behavior change)

**Files:** Create `packages/actions/src/sync/route-schema.ts` + `route-schema.test.ts`; modify `packages/actions/src/sync/route-scan.ts` (emission loop only).

- [ ] Step 1: Write the seam's contract test first: `inferRouteInput(root, route, method, sharedState)` returns `null` for a handler with no recognizable input, and route-scan's output with the seam wired is **byte-identical** to today's for the existing route-scan test fixtures (snapshot the current `scanRoutes` results for every existing fixture in `route-scan.test.ts` before touching anything; these snapshots are the no-regression net for the whole PR).
- [ ] Step 2: Implement the empty seam: `route-schema.ts` exports `inferRouteInput` (returns null for now) and a `RouteInputResult` shape carrying `{ bodySchema?, queryProperties?, note? }`; route-scan calls it per (route, method) and, on null, emits exactly what it emits today. On non-null (later tasks), merge: path params from `routeInputSchema` stay, body schema replaces the blank object for body-bound methods, query properties merge for query-bound ones, `note` lands on the tool.
- [ ] Step 3: All existing route-scan tests plus the new snapshots green. Commit: `actions(route-scan): collector seam for input-schema inference (no behavior change)`.

### Task 2: The zod collector

**Files:** Modify `route-schema.ts` + `route-schema.test.ts`.

- [ ] Step 1: Failing fixture tests first, in the temp-dir style of `trpc.test.ts` (`fs.mkdtemp`, write a synthetic Next repo). Cover: (a) `schema.parse(await req.json())` with `schema = z.object(...)` in the same file → real schema with correct required/optional; (b) validator imported from another file (exercises `resolveIdentifier`); (c) `safeParse` variant; (d) inline `z.object(...).parse(await req.json())`; (e) a handler whose zod expression the reader can't interpret → permissive schema + note (assert the note's reason text); (f) a handler with no zod at all → null (falls through to Task 3's collector).
- [ ] Step 2: Implement: walk the handler function body (the route module is already parsed — reuse `parseModuleSource`/`walk` from `common.ts` as route-scan does) for call expressions whose callee is `.parse`/`.safeParse` applied to an argument containing `await <req>.json()`; take the callee's receiver expression and hand it to `zodFromExpression` with a `StaticExtraction` threaded through the shared per-scan state. First match wins; a recognized-with-reason result keeps the schema and carries the reason into `note`.
- [ ] Step 3: Fixture tests green; snapshot tests from Task 1 still byte-identical (fixtures there have no zod). Commit: `actions(route-scan): zod-in-handler collector — reuse the oracle-hardened reader for body schemas`.

### Task 3: The checker collector

**Files:** Modify `route-schema.ts` + `route-schema.test.ts`.

- [ ] Step 1: Failing fixture tests first: (a) `(await req.json()) as TransferBody` with a local `type TransferBody = { amount: number; recipient: string; memo?: string }` → object schema, `memo` optional; (b) an annotated variable (`const body: TransferBody = await req.json()`); (c) a type imported from another file; (d) literal-union property (`status: "draft" | "sent"` → enum-shaped); (e) nested object and array-of-object properties; (f) a type outside the supported subset (e.g. a mapped/generic type) → permissive + note; (g) a JS-only repo (no tsconfig, `.js` handler) → null and a single scan-level warning, asserted through `scanRoutes`' warnings; (h) unannotated `await req.json()` with no reads → null (stays permissive, the voice-proxy case).
- [ ] Step 2: Implement the shared lazy program: the per-scan state builds ONE `ts.createProgram` over the route files on first need, using the host's compiler via `loadTypescript(root)` and the host's tsconfig when present (`ts.findConfigFile`/`readConfigFile`); failure of any step degrades to null + one warning. Then per handler: find the body expression (the cast or annotated declaration feeding from `req.json()`), ask the checker for its type, and convert a bounded subset to JSON Schema — primitives, string/number literal unions, arrays, nested object literals, optionality from `?`/undefined-union. Depth-cap the conversion (follow `MAX_RESOLVE_DEPTH` precedent) and fail closed per property like `zodBase`'s object case does (unknown property → `{}` + reason).
- [ ] Step 3: Order: this collector runs only when Task 2's returned null. Perf guard test: a fixture with three routes builds the program once (assert via an injectable counter on the shared state, not timing).
- [ ] Step 4: Fixture tests green, snapshots intact. Commit: `actions(route-scan): checker collector — body schemas from TypeScript types (lazy shared program)`.

### Task 4: The query collector

**Files:** Modify `route-schema.ts` + `route-schema.test.ts`.

- [ ] Step 1: Failing fixtures: (a) `searchParams.get("status")` and `.getAll("tag")` literal reads → optional string properties (`tag` array-of-string), merged into a GET tool's schema alongside its path params; (b) the same reads in a handler that ALSO got a body schema from Task 2/3 → both present (body props + query props per the tool's argsIn rules — check how the runtime routes query args for body-bound methods before deciding where merged query props live; follow `registry.ts`'s route execution, and document the choice in the module comment); (c) a computed key (`searchParams.get(key)`) → ignored, no note (absence of evidence).
- [ ] Step 2: Implement additive collection over the handler body's `searchParams.get/getAll` string-literal calls (both `req.nextUrl.searchParams` and `new URL(req.url).searchParams` receiver shapes). Query-derived properties are always optional — never touch `required` (spec's fail-closed rule).
- [ ] Step 3: Green + snapshots intact. Commit: `actions(route-scan): query collector — literal searchParams reads become optional string properties`.

### Task 5: Fail-closed invariants and drift integration

**Files:** Modify `packages/actions/src/sync/route-scan.test.ts` (or a new `route-schema.integration.test.ts` if cleaner); read `sync/index.ts` (no changes expected).

- [ ] Step 1: Invariant tests over the whole extractor: (a) inference never changes a tool's name, binding, risk, or disabled flag (compare full tool objects minus inputSchema across a fixture with and without collectors finding anything); (b) a property becomes required ONLY via zod evidence (checker-collector requireds allowed only from non-optional TS properties — assert a case); (c) inferring a schema where none existed registers as `input-narrowed` breaking-change candidate in `vendoSync`'s diff — run `vendoSync` twice over a fixture whose handler gains a zod validator between runs and assert the report calls it breaking (this is `inputNarrowed` doing its job; the PR description must call out that first-sync-after-upgrade will report narrowing on previously-blank tools, and why that's correct).
- [ ] Step 2: Green. Commit: `actions(route-scan): inference invariants — narrow-only, evidence-gated required, drift visible`.

### Task 6: Real-world verification

- [ ] Step 1: Run `vendo sync` (via the built CLI or `vendoSync` directly) against `apps/demo-bank` and `apps/demo-accounting`; review the tools.json diff by hand. Expect: route-bound tools whose handlers read typed/zod input gain real schemas; OpenAPI-bound tools byte-identical; anything surprising gets investigated before proceeding.
- [ ] Step 2: Corpus spot-check on two cloned repos with route-heavy surfaces (`pnpm corpus run umami --layer 2` and `pnpm corpus run papermark --layer 2` from the repo root; both were Layer-1 green on the post-#437 nightly). Read the tools.precision/recall/annotations checks: expectation files under `corpus/expectations/<repo>/` that pin route-tool schemas will drift — update them in this PR with the new, better schemas (expected drift, mirrors the spec's testing section). If precision drops for any repo, that's a real inference bug — triage before touching expectations.
- [ ] Step 3: Commit fixtures/expectation updates: `corpus: expectations updated for route-scan inferred schemas`.

### Task 7: Ship

- [ ] Step 1: Repo gate: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` — all green.
- [ ] Step 2: PR titled `actions(route-scan): infer input schemas from in-handler zod and TypeScript types` — body covers: the two collectors and their order, the fail-closed rules (narrow-only, evidence-gated required, permissive fallback byte-identical), the demo-app diff summary, the corpus before/after on the two spot-checked repos, the input-narrowed drift caveat for existing installs, and a link to the spec. Note PR 1 (#424, the oracle suite) as the hardening this builds on.

---

## Decisions locked during planning

- Collectors live in a new `route-schema.ts`, not inside `route-scan.ts` (459 lines already; discovery and inference are separate responsibilities); route-scan calls one function at its single emission point.
- Snapshot-pinning the current fixtures BEFORE any change is the no-regression mechanism for the entire PR (fail-closed means byte-identical output when collectors find nothing).
- Zod collector wins over checker collector (a validator is stronger evidence than a type); query collector is additive to either.
- The checker program is per-scan, built lazily on first need, never persisted (watch-mode correctness follows route-scan's existing fresh-parse behavior; `clearAliasCache` precedent covers tsconfig edits).
- tools.precision triage on the other six nightly-flagged repos is OUT of this PR — this PR only updates expectations for the two spot-checked repos it verifies against.
