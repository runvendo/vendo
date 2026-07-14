# Sync Completion (Section D, ENG-261) Implementation Plan

> **For agentic workers:** Execute task-by-task with TDD and frequent commits. Steps use checkbox (`- [ ]`) syntax for tracking. The spec is `docs/superpowers/specs/2026-07-14-block-actions-design.md` Section D (in the parent worktree at `/Users/yousefh/orca/workspaces/flowlet/block-actions`); this plan is derived from it — do not re-litigate decisions.

**Goal:** `vendo sync` tells you what a change breaks before it breaks it: a blast-radius endpoint maps breaking/changed tools to the saved apps, automations, and standing grants that reference them; grant invalidation is loud (audit event + UI notice); `vendo init` scaffolds predev/prebuild sync hooks; `--strict` gains distinct exit codes and `--report` pushes to the Cloud console.

**Architecture:** Two independent tracks, one PR each.
- **Track 1 (blast-radius pipeline):** a dev-gated `POST /sync/impact` wire route on the umbrella (`packages/vendo/src/server.ts` if-ladder) backed by a new impact module that queries `vendo_apps` + `vendo_grants`; `vendo sync` probes it doctor-style and prints per-tool impact; exit codes 2 (breaking) / 3 (breaking + nonzero blast radius); `--report` pushes via the `cloudFetch` key-auth pattern; `vendo init` adds `predev`/`prebuild` scripts through the existing permission-prompted diff flow.
- **Track 2 (loud grant invalidation):** `guard.#matchingGrant` detects same-tool grants skipped only because `descriptorHash` drifted, emits a `policy-decision` audit event with `detail.reason: "grant-invalidated"`, and the parked approval carries an optional `invalidatedGrant` so the UI approval card renders a "this tool changed since you approved it" notice.

**Tech stack:** TypeScript ESM monorepo (pnpm + turbo), zod schemas in `@vendoai/core`, vitest, PGlite store, e2e in `fixtures/integration` (real `createVendo` over HTTP), Playwright browser fixtures in `fixtures/integration-browser`.

**Verification bar (both tracks):** `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green. Track 1 additionally needs a live demo: a real host (use `fixtures/host-app` or `apps/demo-bank`) where a breaking route change + running dev server makes `vendo sync --strict` print per-tool impact and exit 3. Track 2 additionally needs real-browser screenshots of the UI notice for the PR.

**Interpretations already settled (do not re-decide):**
- "Posture-gated" = the impact endpoint answers only on a dev server: gated on `process.env.NODE_ENV !== "production"`; otherwise respond `VendoError("blocked", "sync impact is only available on a dev server")` (403). There is no dev/prod posture concept in the codebase; this is the chosen gate.
- Exit codes: `0` clean; `2` = `--strict` + breaking extraction changes (status quo); `3` = `--strict` + breaking changes AND the blast-radius query returned nonzero impact for at least one breaking tool. Server unreachable → stays 2 (impact unknown).
- `--report` push failure is a warning, never changes the exit code (sync is fail-soft by doctrine, `packages/vendo/src/cli/sync.ts:12`).
- `ApprovalRequest` gains an OPTIONAL `invalidatedGrant` field and `AuditEvent` usage stays within existing kinds (`policy-decision`) — additive only; the contracts-amendment PR (parent-owned) documents both.

---

## Track 1 — Blast-radius pipeline (worker 1, branch `yousefh409/block-actions-d-blast-radius`)

### Task 1.1: Impact module — map tool names to referencing apps/automations/grants

**Files:**
- Create: `packages/vendo/src/sync-impact.ts`
- Test: `packages/vendo/src/sync-impact.test.ts`

The module exposes:

```ts
export interface ToolImpact {
  tool: string;
  apps: { id: string; title: string }[];        // enabled vendo_apps WITHOUT a trigger that reference the tool
  automations: { id: string; title: string }[]; // enabled vendo_apps WITH a trigger whose steps reference the tool
  grants: number;                               // active (not revoked, not expired) vendo_grants rows with grant.tool === tool
}

export async function computeImpact(store: VendoStore, tools: string[]): Promise<ToolImpact[]>;
```

Implementation notes:
- Use the typed helpers `appStore(store)` (`packages/store/src/helpers/apps.ts:10`) and `grantStore(store)` (`packages/store/src/helpers/grants.ts:19`). Listing must be cross-subject (this is the operator's own dev server); check the helpers' list signatures — if they require a subject, drop to `store.records(...)`/SQL the way `fixtures/integration/src/harness.ts:319` does, or extend the helper with an all-subjects list. Prefer the smallest change.
- Tool references inside an `AppDocument`: steps' `step.tool` values (validated at `packages/core/src/app-document.ts:146-152`) plus any direct host-tool references the document model allows. Read `packages/core/src/app-document.ts:37-152` first and write a `referencedTools(doc): Set<string>` collector that skips `fn:` refs (those are app-local functions, not host tools). If core already exports a ref collector, reuse it — do not duplicate.
- An app with `doc.trigger !== undefined` counts as an automation, else as an app (automations are stored as apps; there is no separate table — `packages/store/src/schema.ts:11`).
- Grants: count rows where `tool` matches, `revoked_at` is null, and `expires_at` is null or in the future.

**Steps:**
- [ ] Write failing tests in `sync-impact.test.ts` using an ephemeral store (copy the store-boot pattern from an existing `packages/vendo/src/*.test.ts`): seed one plain app, one automation (app with trigger), one active grant, one revoked grant, one expired grant — all referencing tool `host_get_widgets`; seed one unrelated app. Assert `computeImpact(store, ["host_get_widgets", "host_absent"])` returns exact impact for the first and all-empty impact for the second.
- [ ] Run: `pnpm --filter @vendoai/vendo test -- sync-impact` — expect FAIL (module missing).
- [ ] Implement `sync-impact.ts` minimally to pass.
- [ ] Run the test again — expect PASS.
- [ ] Commit: `feat(vendo): sync impact computation over apps, automations, grants`

### Task 1.2: Wire route `POST /sync/impact`, dev-gated

**Files:**
- Modify: `packages/vendo/src/server.ts` (if-ladder around lines 417-632; deps object at :322 and its population at :748)
- Test: extend `packages/vendo/src/server.test.ts` if it exists, else the module test from 1.1

Behavior:
- `POST {BASE_PATH}/sync/impact` with JSON body `{ "tools": ["host_x", ...] }` (validate: array of strings, cap at 200 entries, else `VendoError("validation", ...)`).
- Gate FIRST: if `process.env.NODE_ENV === "production"`, throw `new VendoError("blocked", "sync impact is only available on a dev server")`.
- Response: `{ "impact": ToolImpact[] }` via `computeImpact(deps.store, body.tools)`.
- No principal resolution needed (it reads operator-level metadata, mirrors `/tick`'s placement before the segment routing — put the branch next to the `/tick` branch at `server.ts:420`).

**Steps:**
- [ ] Write a failing test that builds the handler (follow whatever pattern existing server tests use; if none, do this in the Task 1.5 e2e instead and keep a unit test only for the gate) asserting: 200 + correct shape in dev, 403 `blocked` when `NODE_ENV=production` (set/restore env in the test).
- [ ] Implement the branch in the ladder.
- [ ] Run: `pnpm --filter @vendoai/vendo test` — expect PASS.
- [ ] Commit: `feat(vendo): dev-gated POST /sync/impact wire route`

### Task 1.3: `vendo sync` queries impact + distinct exit codes

**Files:**
- Modify: `packages/vendo/src/cli/sync.ts`, `packages/vendo/src/cli.ts` (flag parsing at :50, HELP at :9)
- Test: `packages/vendo/src/cli/sync.test.ts`

Behavior (mirror `doctor.ts` exactly for server discovery — `packages/vendo/src/cli/doctor.ts:85-91`):
- New `SyncOptions` fields: `url?: string`, `fetchImpl?: typeof fetch`, `report?: boolean`, `push?: (report) => Promise<void>` (injectable for tests).
- Impact URL: `options.url ?? process.env.VENDO_URL ?? "http://localhost:3000/api/vendo"`, then `POST {base}/sync/impact` with `{ tools }` where `tools = union(report.breaking[].tool, report.tools.changed)`, only when that union is nonempty.
- On success, print one line per impacted tool: `impact: host_x breaks 2 automations, 1 app, 3 grants` (omit zero categories; print `impact: host_x no saved references` when all zero).
- On any fetch/parse failure print exactly one line: `impact unknown — dev server not reachable at <url>` and continue (graceful fallback, spec D).
- Exit codes with `--strict`: breaking + at least one breaking tool with nonzero impact → return 3; breaking otherwise → 2 (including unreachable server); no breaking → 0. Keep the catch-path `strict ? 2 : 0`.
- Wire `--url` through `cli.ts` (`option(args, "--url")` like doctor at `cli.ts:48`) and update HELP to document exit codes 0/2/3.

**Steps:**
- [ ] Extend `sync.test.ts` (existing injectable pattern, `sync.test.ts:14-16`) with failing tests: (a) impact lines printed from a stubbed `fetchImpl`; (b) unreachable server → fallback line + exit 2 under strict; (c) breaking + nonzero impact → exit 3; (d) breaking + zero impact → 2; (e) no breaking → no impact query issued.
- [ ] Run: `pnpm --filter @vendoai/vendo test -- cli/sync` — expect FAIL.
- [ ] Implement; run again — expect PASS.
- [ ] Commit: `feat(cli): vendo sync blast-radius query with distinct strict exit codes`

### Task 1.4: `--report` push to Cloud console

**Files:**
- Modify: `packages/vendo/src/cli/sync.ts`, `packages/vendo/src/cli.ts`, `packages/vendo/src/cli/cloud/services.ts` (or a small helper it exports)
- Test: extend `packages/vendo/src/cli/sync.test.ts`

Behavior:
- `vendo sync --report` posts `{ report, impact, at }` (impact only if fetched) to `POST /api/v1/sync/report` using the `cloudFetch` key-auth pattern (`packages/vendo/src/cli/cloud/client.ts:120-136`; `--key`/`VENDO_API_KEY`, `--api-url`/`VENDO_CLOUD_URL`).
- Missing key → one warning line (`--report requires VENDO_API_KEY or --key`), exit code unchanged. Push failure → warning line, exit code unchanged.
- NOTE for PR body: the console-side `/api/v1/sync/report` endpoint does not exist yet (separate repo); this ships the client half — flag it in the PR description.

**Steps:**
- [ ] Failing tests: report pushed with stubbed fetcher when key present; warning + unchanged exit code when key absent; warning + unchanged exit code when push rejects.
- [ ] Implement; run `pnpm --filter @vendoai/vendo test` — expect PASS.
- [ ] Commit: `feat(cli): vendo sync --report pushes sync report to Cloud console`

### Task 1.5: init scaffolds predev/prebuild hooks (permission-prompted)

**Files:**
- Modify: `packages/vendo/src/cli/init.ts` (`buildPlan` at :373, apply loop at :557-563)
- Test: `packages/vendo/src/cli/init.test.ts`

Behavior:
- Add a package.json code-change candidate to `buildPlan`'s `changes` (same `{ absolute, path, before, after, diff }` shape as route wiring, so it rides the existing confirm loop and the `--agent` JSON plan for free):
  - `scripts.predev`: absent → `"vendo sync"`; present without `vendo sync` → prepend `"vendo sync && "` + existing; already contains `vendo sync` → no change offered (idempotent).
  - `scripts.prebuild`: same with `"vendo sync --strict"`.
- Preserve file formatting: `JSON.parse`, mutate, `JSON.stringify(pkg, null, detectedIndent)` where indent is detected from the raw text (default two spaces); keep trailing newline if present.
- Declined prompt → skipped, like route wiring.

**Steps:**
- [ ] Failing tests in `init.test.ts` (mkdtemp pattern, stub `confirm`): hooks added on approval; prepend when scripts exist; idempotent re-run offers no package.json change; declined → untouched; `--agent` plan JSON includes the package.json diff.
- [ ] Run: `pnpm --filter @vendoai/vendo test -- cli/init` — expect FAIL, implement, expect PASS.
- [ ] Commit: `feat(cli): vendo init scaffolds predev/prebuild sync hooks`

### Task 1.6: e2e + live demo proof

**Files:**
- Create: `fixtures/integration/src/sync-impact.e2e.test.ts`
- Demo evidence: terminal transcript + notes for the PR body

**Steps:**
- [ ] e2e (follow `fixtures/integration/src/away-park-revoke.e2e.test.ts` structure): `createStack()`; seed via wire an app, an automation, and a grant referencing a known fixture tool; `stack.wireFetch("/sync/impact", { method: "POST", body: ... })`; assert counts. Also assert the 403 gate by spawning the handler with `NODE_ENV=production` if the harness permits, else cover the gate in the unit test only.
- [ ] Run: `pnpm --filter @vendoai-fixtures/integration test -- sync-impact` — expect PASS.
- [ ] Live demo: in `fixtures/host-app` (or demo-bank), start the dev server, create a grant/automation via the UI or wire, then make a breaking route change (add a required param to an extracted route), run `pnpm vendo sync --strict` → capture output showing `breaking:` lines, per-tool `impact:` lines, and `echo $?` → `3`. Save transcript for the PR body.
- [ ] Full gate: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` — all green.
- [ ] Commit + open PR titled `feat(sync): blast-radius impact endpoint, strict exit codes, --report, init hooks (ENG-261)` with the demo transcript. Do NOT merge — report back.

---

## Track 2 — Loud grant invalidation (worker 2, branch `yousefh409/block-actions-d-grant-invalidation`)

### Task 2.1: Detect + audit invalidated grants in guard

**Files:**
- Modify: `packages/guard/src/guard.ts` (`#matchingGrant` :877-900, `#parkApproval` :902, `check()` ask-path ~:480-525)
- Modify: `packages/core/src/grants.ts` (ApprovalRequest type + schema — OPTIONAL field only)
- Test: `packages/guard/src/guard.test.ts` (or the file where grant-matching tests live — find `#matchingGrant`'s existing coverage first)

Behavior:
- `#matchingGrant` currently skips hash-drifted grants silently (`guard.ts:892`). Change its return to `{ grant?: PermissionGrant; invalidated: PermissionGrant[] }` where `invalidated` collects grants that match subject + tool + not revoked + not expired + duration/presence, but fail ONLY the `descriptorHash` comparison. (Scope mismatch stays silent — that's argument-level, not contract drift.)
- In the ask-path where a would-be run parks an approval: if `invalidated` is nonempty, (a) append ONE audit event via the existing emitter (`guard.report` / `eventFromContext`, `guard.ts:138,360`): `kind: "policy-decision"`, `outcome: "pending-approval"`, `decidedBy: "default"`, `tool`, and `detail: { reason: "grant-invalidated", grantIds, tool, staleHash, currentHash }`; (b) the parked `ApprovalRequest` carries `invalidatedGrant: { id, grantedAt }` (first invalidated grant).
- `ApprovalRequest` addition is OPTIONAL in both type and zod schema — existing stored approvals must still parse.

**Steps:**
- [ ] Failing unit tests: grant with stale hash → approval parked with `invalidatedGrant` set + one `policy-decision` audit event with `detail.reason === "grant-invalidated"`; fresh-hash grant → no event, no field; no grant at all → no event, no field (first-time ask stays undistinguished); revoked/expired stale-hash grants do NOT count as invalidated.
- [ ] Run: `pnpm --filter @vendoai/guard test` — expect FAIL, implement, expect PASS.
- [ ] Also run `pnpm --filter @vendoai/core test` (schema change).
- [ ] Commit: `feat(guard): loud grant invalidation — audit event + invalidatedGrant on approvals`

### Task 2.2: UI notice on the approval card

**Files:**
- Modify: the approval card component in `packages/ui` (start from `packages/ui/src/chrome/vendo-thread.tsx:20,204` and `packages/ui/src/hooks/use-vendo-thread.ts:18,26` to find where `data-vendo-approval` renders; the notice pattern to follow is `ContainedNotice`, `packages/ui/src/tree/notice.tsx:28`)
- Test: colocated UI test following existing `packages/ui` test conventions (note: fluidkit is alias-stubbed package-wide via vitest alias — see memory `vendo-tidy-wave`; wait on committed outcome state, not mock calls)

Behavior:
- When the approval payload has `invalidatedGrant`, the approval card shows a brand-native notice line above the approve/deny controls: `This tool changed since you approved it on <date> — your previous permission no longer applies.` No notice otherwise.
- The Activity panel needs no code change (the audit event flows through `/activity` already) — verify it renders and screenshot it.

**Steps:**
- [ ] Failing UI test: render approval card with `invalidatedGrant` → notice text present; without → absent.
- [ ] Run: `pnpm --filter @vendoai/ui test` — expect FAIL, implement, expect PASS.
- [ ] Commit: `feat(ui): surface invalidated-grant notice on approval card`

### Task 2.3: e2e + browser screenshots

**Files:**
- Create: `fixtures/integration/src/grant-invalidation.e2e.test.ts`
- Browser evidence: screenshots via `fixtures/integration-browser` or a live demo host

**Steps:**
- [ ] e2e: `createStack()`; approve a tool with an always-duration grant; mutate the tool's descriptor (the harness loads `.vendo/tools.json` from the integration fixture dir — write a temp copy with a changed schema, or drive the descriptor through `scriptedModel`); call the tool again; assert: new approval parked WITH `invalidatedGrant`, `vendo_audit` contains the `policy-decision` event with `detail.reason = "grant-invalidated"` (use `stack.sql`).
- [ ] Run: `pnpm --filter @vendoai-fixtures/integration test -- grant-invalidation` — expect PASS.
- [ ] Real-browser proof: boot a browser fixture or demo host, trigger the flow, screenshot BOTH the approval-card notice and the Activity panel event. UI changes are not done without this (repo rule).
- [ ] Full gate: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` — all green.
- [ ] Commit + open PR titled `feat(guard,ui): loud grant invalidation on descriptor drift (ENG-261)` with screenshots. Do NOT merge — report back.

---

## Self-review notes (already applied)

- Spec D coverage: blast-radius endpoint (1.1/1.2), sync query + fallback (1.3), init hooks (1.5), distinct exit codes (1.3), --report (1.4), loud invalidation audit + UI (2.1/2.2), e2e + live proof (1.6/2.3). Complete.
- Cross-track type touchpoint: none — tracks share no new symbols; safe to run in parallel.
- Known open items to surface in PR bodies: console-side `/api/v1/sync/report` endpoint (Cloud repo, parent scope); contracts-amendment notes for `ApprovalRequest.invalidatedGrant` + audit `detail.reason` (parent-owned amendment PR).
