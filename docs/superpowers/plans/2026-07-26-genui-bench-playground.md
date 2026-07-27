# genui-bench Playground Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/genui-bench` — the interactive inner-loop playground: prompt in → four side-by-side lanes (Vendo live+interactive, Thesys C1, CopilotKit, Tambo) → RunRecords on disk with history/pinning; same runner drivable headlessly via CLI.

**Architecture:** Private Next.js workspace app (mirrors demo-host conventions; never published/deployed). A framework-free `runner/` library is the single generation path; the cockpit UI and `cli.ts` are thin callers. The Vendo lane calls `modelEngine.create` from workspace source with an `onPipeline` tap; the pane renders the resulting AppDocument through the production `@vendoai/ui` renderer wired to EXECUTABLE fixture tools (canned data through the real ToolRegistry/guard path) so the generated app is fully interactive. Competitor SDKs exist only in this app's package.json.

**Tech Stack:** Next.js (same major as apps/demo-bank), TypeScript, vitest, `@vendoai/apps` engine + bench fixtures, `@vendoai/ui` renderer/Kit, Thesys C1 SDK, CopilotKit, Tambo SDK.

**Spec:** `docs/superpowers/specs/2026-07-26-genui-bench-playground-design.md` (binding; re-read before starting).

**Worktree law:** all work in THIS worktree (`.../flowlet/format`), branch `yousefh409/format` stacked after the de-versioning PR #613 — de-versioned names (`compileWire`, `validateTree`, `VENDO_TREE_FORMAT`) are what you import.

---

## Shared contracts (Lane 0 — everything else builds against this, so it lands first)

### Task 0: Scaffold app + pin the shared types

**Files:**
- Create: `apps/genui-bench/package.json`, `tsconfig.json`, `next.config.mjs`, `.gitignore` (`runs/`), `vitest.config.ts`
- Create: `apps/genui-bench/runner/types.ts` (the contract file — verbatim below)
- Create: `apps/genui-bench/packs/smoke.json`

- [ ] **Step 1: Scaffold the workspace app.** Copy conventions from `apps/demo-bank/package.json` (same Next/TS/vitest majors, `"private": true`). Name `genui-bench`. No `vendo sync` pre-scripts (this app hosts no Vendo install; it drives the engine directly). Dependencies: `@vendoai/apps`, `@vendoai/core`, `@vendoai/ui`, `@vendoai/guard`, `next`, `react`, `react-dom`. Competitor SDKs are added only in Lane D tasks. Register in the pnpm workspace (verify `pnpm-workspace.yaml` already globs `apps/*` — if so, nothing to do).
- [ ] **Step 2: Write `runner/types.ts` exactly:**

```ts
import type { AppDocument } from "@vendoai/core";
import type { PipelineEvent } from "@vendoai/apps";

export type LaneName = "vendo" | "thesys-c1" | "copilotkit" | "tambo";
export type HostName = "maple" | "cadence";

export interface RunRequest {
  prompt: string;
  host: HostName;
  lanes: LaneName[];
  /** Set when the prompt came from a pack (evidence labeling only). */
  packRef?: { pack: string; index: number };
}

export type LaneResult =
  | { status: "ok"; startedAt: number; durationMs: number; costUsd?: number;
      /** Vendo lane: the document to render live. */
      document?: AppDocument;
      /** Vendo lane: raw wire text as streamed. */
      wire?: string;
      /** Vendo lane: the tapped pipeline events (JSON-safe). */
      events?: PipelineEvent[];
      /** Competitor lanes: their raw response payload, renderable by their SDK. */
      raw?: unknown }
  | { status: "failed"; startedAt: number; durationMs: number; error: string;
      events?: PipelineEvent[]; wire?: string; raw?: unknown }
  | { status: "no-key" };

export interface RunRecord {
  id: string;                      // `${yyyymmdd-hhmmss}-${4 hex}`
  createdAt: string;               // ISO
  gitSha: string;
  gitDirty: string | null;         // sha256 of `git diff` when tree dirty, else null
  request: RunRequest;
  lanes: Partial<Record<LaneName, LaneResult>>;
  pin?: string;                    // label; absence = unpinned
}

export interface LaneAdapter {
  name: LaneName;
  /** Resolve to a LaneResult; NEVER throw — catch and return status:"failed". */
  generate(prompt: string, host: HostFixture): Promise<LaneResult>;
}

/** Executable host fixture — catalog/tools/shapes for generation, executors for interaction. */
export interface HostFixture {
  name: HostName;
  catalog: unknown;                // NormalizedCatalog (from @vendoai/core)
  tools: unknown[];                // HostToolInfo[] (from @vendoai/apps)
  shapes: unknown;                 // shape cards, bench demo-bank-surface pattern
  theme: unknown;                  // host theme tokens for the renderer
  /** Canned-data executor: same names as `tools`; throws VendoError for unknown tool. */
  execute(tool: string, input: Record<string, unknown>): Promise<unknown>;
}
```

- [ ] **Step 3: Seed `packs/smoke.json`:** `{ "name": "smoke", "prompts": ["show my account balances at a glance", "let me transfer money between my accounts", "show my recent transactions with search" ] }`. (standard/stress packs are a later task, same shape.)
- [ ] **Step 4: `pnpm install`, then commit** `chore(genui-bench): scaffold app + pin runner contracts`.

### Task 1: Runner core + RunRecord persistence (TDD)

**Files:**
- Create: `apps/genui-bench/runner/run.ts` (`executeRun(req, fixtures, adapters, runsDir) → Promise<RunRecord>`)
- Create: `apps/genui-bench/runner/store.ts` (`saveRun`, `listRuns`, `loadRun`, `setPin`)
- Test: `apps/genui-bench/runner/run.test.ts`

- [ ] **Step 1: Failing tests first** — with two fake adapters (one resolves ok after 5ms, one rejects): `executeRun` (a) runs enabled lanes concurrently, (b) never rejects, (c) marks the rejecting lane `failed` with the error message, (d) persists `runs/<id>/run.json` + per-lane artifact files, (e) stamps `gitSha` (mock the git call) and `gitDirty` null/hash. Also: `setPin` round-trips; `listRuns` sorts newest-first.
- [ ] **Step 2: Run `pnpm --filter genui-bench test` — expect FAIL** (modules missing).
- [ ] **Step 3: Implement minimal `run.ts` + `store.ts`.** Artifacts: `run.json` (RunRecord minus bulky fields) + `vendo.wire.txt`, `vendo.document.json`, `vendo.events.json`, `<lane>.raw.json` as applicable. Lane concurrency via `Promise.allSettled`. Git state via `git rev-parse HEAD` / `git diff` (child_process, cwd = repo root).
- [ ] **Step 4: Tests green, commit** `feat(genui-bench): runner core + run persistence`.

### Task 2: CLI

**Files:** Create `apps/genui-bench/cli.ts`; add package script `"bench": "tsx cli.ts"`.

- [ ] **Step 1: Failing test** (spawn CLI with `--host maple --prompt "hi" --lanes vendo` against a stub adapter module injected via `GENUI_BENCH_FAKE_LANES=1` env): exits 0, prints the RunRecord path and one JSON summary line `{"runs":[{"prompt":"hi","vendo":{"status":"ok","durationMs":…,"repairs":0}}]}`.
- [ ] **Step 2: Implement.** Flags: `--host`, `--prompt` (repeatable) OR `--pack <name>`, `--lanes` (comma list, default `vendo`). Repair count = count of repair-tagged PipelineEvents. Loads root `.env` via the source-only pattern (never prints values).
- [ ] **Step 3: Green, commit** `feat(genui-bench): headless CLI`.

---

## Lane B: Vendo lane + executable fixtures (the heart — start immediately after Task 0)

### Task 3: Host fixtures (Maple + Cadence), executable

**Files:**
- Create: `apps/genui-bench/fixtures/maple.ts`, `fixtures/cadence.ts`, `fixtures/index.ts`
- Test: `apps/genui-bench/fixtures/fixtures.test.ts`

- [ ] **Step 1:** Reuse `packages/apps/src/bench/demo-bank-surface.ts` loaders (import from `@vendoai/apps` if exported; otherwise export them from the bench barrel first — small PR-safe change) for Maple's catalog/tools/shapes; build the Cadence equivalent from `apps/demo-accounting/.vendo/*.json` with shape cards mirroring `apps/demo-accounting/src/server/types.ts`. Theme: load each demo's theme tokens (`.vendo/theme.json` or the demo's theme source — check both demos, use what exists).
- [ ] **Step 2: Executors.** For each host tool named in `tools`, implement a canned-data executor returning shape-conformant data (accounts, transactions, invoices…, ~deterministic: fixed seed data module, no `Math.random`). Failing test: every tool in the catalog has an executor; every executor's output passes the fixture's own shape card (reuse the shape-check helpers from `@vendoai/core`); unknown tool throws `VendoError`.
- [ ] **Step 3: Green, commit** `feat(genui-bench): executable Maple/Cadence host fixtures`.

### Task 4: Vendo lane adapter (generation + event tap)

**Files:** Create `apps/genui-bench/lanes/vendo.ts`; test `lanes/vendo.test.ts`.

- [ ] **Step 1: Failing test** with a stubbed engine (inject `GenerationDependencies`-shaped fake): adapter returns `document`, `wire`, ordered `events`, `durationMs`; engine throw → `status:"failed"` WITH the partial events captured up to the throw.
- [ ] **Step 2: Implement:** compose `modelEngine.create` inputs exactly the way `packages/apps/src/bench/runner.ts` does (catalog/tools/shapes/theme from the HostFixture; production `wire-options.ts` dialect; real model via root-`.env` key), passing `onPipeline` to accumulate events. Do not fork engine config — production `PipelineConfig` defaults.
- [ ] **Step 3: Green, commit** `feat(genui-bench): vendo lane adapter with pipeline tap`.

### Task 5: Interactive Vendo pane runtime (exact Kit, live tool calls)

**Files:**
- Create: `apps/genui-bench/cockpit/VendoPane.tsx`
- Create: `apps/genui-bench/app/api/tools/route.ts` (POST `{host, tool, input}` → fixture `execute`)
- Test: `apps/genui-bench/cockpit/vendo-pane.test.tsx`

- [ ] **Step 1:** Study how `apps/demo-bank` mounts generated apps (its surface/dock components wiring `@vendoai/ui` renderer + tool transport + theme). Mirror THAT wiring: real Kit registry, real renderer, real ToolRegistry/guard client path, theme from the fixture — the only substitution is the tool transport pointing at `/api/tools` (fixture executors).
- [ ] **Step 2: Failing test (jsdom):** render VendoPane with a canned AppDocument fixture whose tree has one query + one action; assert (a) it renders through the production renderer (Kit component present), (b) the query fires a POST to the mocked `/api/tools` and renders returned canned data, (c) clicking the action fires the tool call.
- [ ] **Step 3: Implement; green; commit** `feat(genui-bench): interactive Vendo pane on production renderer + executable tools`.

---

## Lane C: Cockpit UI (start after Task 0; integrate panes as B/D land)

### Task 6: App shell per approved mockup

**Files:** Create `apps/genui-bench/app/page.tsx`, `app/layout.tsx`, `cockpit/{TopBar,PromptRow,HistoryRail,PaneGrid,InternalsDrawer}.tsx`, `app/api/run/route.ts`, `app/api/runs/route.ts`, `app/api/git-state/route.ts`.

- [ ] **Step 1:** Implement the approved mockup (`docs/superpowers/specs/assets/2026-07-26-genui-bench-mockup.html` is the visual contract — dark cockpit, same layout/regions). Invoke the `design` skill for this task's UI work.
- [ ] **Step 2:** Wire: PromptRow → POST `/api/run` (calls `executeRun`, streams lane completion via SSE or simple polling of the run dir — pick polling first, simplest); HistoryRail → `/api/runs` (`listRuns`); TopBar git state → `/api/git-state` (sha + dirty file summary via `git status --porcelain`, refreshed on window focus); Packs dropdown reads `packs/*.json`, "save to pack" appends.
- [ ] **Step 3: Boot smoke test:** vitest + a canned RunRecord dir fixture: page renders rail entries and pane placeholders. Commit `feat(genui-bench): cockpit shell wired to runner`.

### Task 7: Internals drawer + split-compare

- [ ] **Step 1:** InternalsDrawer renders the `vendo.events.json` timeline (tag → color classes per mockup) + tabs: wire text, document JSON, per-competitor raw. Test with a canned events fixture: repair + guardrail events render with their payloads.
- [ ] **Step 2:** Split-compare: ⌥-click a rail run → Vendo pane splits (two VendoPanes, both read-only documents), drawer shows both event timelines stacked. Pin toggle on each rail row → `setPin`. Test: pinned runs sort first; compare mode renders two documents.
- [ ] **Step 3:** Commit `feat(genui-bench): internals drawer, split-compare, pinning`.

---

## Lane D: Competitor lanes (start after Task 0; each sub-task independently landable)

**Shared rules:** each adapter implements `LaneAdapter`, guards on its env key (absent → `{status:"no-key"}`), and ships a recorded-fixture contract test (record one real response manually once; CI never calls live APIs). Each pane component renders the lane's `raw` with THEIR SDK and carries the permanent asymmetry footnote from the spec. Before coding each, pull current docs via context7 (`resolve-library-id` then `query-docs`) — all three SDKs move fast.

### Task 8: Thesys C1 lane
- [ ] Adapter: translate the HostFixture tool catalog to C1's tool format, send prompt, capture full response into `raw`. Pane: their React renderer. Env: `THESYS_API_KEY`. Footnote: "their renderer/theme · same prompt + tools". Contract test on recorded fixture. Commit.

### Task 9: CopilotKit lane
- [ ] Harness: register chart/table/form components matching each host's domain + the same tools (fixture-executor backed). Adapter drives one conversation turn with the prompt; `raw` = messages + rendered component intents. Footnote: "registered-components paradigm — shows how it drives predefined components, not open-ended generation". Env: `COPILOTKIT_API_KEY` (or self-hosted runtime if the SDK allows keyless local — prefer keyless). Contract test. Commit.

### Task 10: Tambo lane
- [ ] Same harness treatment as CopilotKit with Tambo's registry API. Verify current API shape via context7/web first (young product — if the SDK is unusable in a headless harness, implement the pane as "embedded live widget only" and record that limitation in the pane footnote + report it). Env: `TAMBO_API_KEY`. Contract test. Commit.

---

## Task 11: Integration + gates

- [ ] **Step 1:** `pnpm genui-bench run --host maple --pack smoke --lanes vendo` end-to-end with a REAL model key (one live run, ~3 prompts): RunRecord complete, document renders in cockpit, tool calls execute, internals timeline populated. Screenshot the cockpit for the PR (UI-affecting → real-browser proof rule).
- [ ] **Step 2:** Repo gates: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green from root (dependency-guard must not flag genui-bench; it's an app, not a package).
- [ ] **Step 3:** README: `apps/genui-bench/README.md` — what it is, `pnpm --filter genui-bench dev`, CLI usage, key requirements per lane, packs format, runs layout. Commit; PR per repo rules.

## Self-review checklist (done at plan time)

- Spec coverage: every spec section maps to a task (cockpit→6/7, runtime-interactive→3/5, lanes→8-10, runs/pins/CLI→1/2, testing→in each task, delivery lanes→structure).
- No placeholder steps: each step names exact files, the pattern-source file to mirror, and the test that proves it.
- Type consistency: all tasks import from `runner/types.ts` (Task 0) — `LaneResult`, `RunRecord`, `HostFixture`, `LaneAdapter` names are canonical.
