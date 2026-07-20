# Corpus Nightly Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the corpus nightly to a meaningful measuring stick by fixing the four diagnosed regressions (stale VendoRoot check, zod-floor gap, pnpm-11 bootstrap gap, scorecard-artifact diagnostic) and confirming the two open ones (rallly, invoify/cal-com/umami typechecks).

**Architecture:** All fixes land on branch `yousefh409/corpus-triage` (worktree `/Users/yousefh/orca/workspaces/flowlet/corpus-triage`, based on `origin/main` @ 93a2e082) as one PR. Each fix is an independent commit with its own tests. Diagnoses were produced 2026-07-20 by three investigation agents; their findings are restated per task below — implementers work from this plan alone.

**Decisions locked by Yousef (2026-07-20):** the harness performs the VendoRoot paste itself after init (corpus green keeps meaning "fully wired app end to end"), and additionally asserts init printed the paste instructions. All clear-cut fixes proceed now; rallly is fixed only after a confirming rerun.

---

### Task 1: Harness performs the VendoRoot paste (fix #1)

**Context:** Commit `f2c23568` deliberately removed init's layout codemod; `vendo init` now prints paste-lines (see `vendoRootPasteLines`, `packages/vendo/src/cli/init.ts:822-856`) and never edits `layout.tsx`. The Layer-1 check in `corpus/harness/src/layers/structural.ts` (~line 291) still hard-requires the wrap in `layout.tsx`, so every Next repo fails `files.expected`.

**Files:** `corpus/harness/src/` (structural layer + wherever the harness invokes init — follow the run pipeline), plus harness unit tests.

- [ ] Step 1: Read `corpus/harness/src/layers/structural.ts` and the init invocation path to locate where a post-init step belongs.
- [ ] Step 2: Write failing unit tests first: (a) after the harness's init step on a synthetic Next fixture, `layout.tsx` contains the VendoRoot wrap applied BY THE HARNESS; (b) the harness asserts init's stdout contained the paste-lines block and fails the check when absent; (c) a repo whose layout already contains VendoRoot is left unchanged (idempotent).
- [ ] Step 3: Implement: after `vendo init` succeeds, the harness applies the documented one-line paste (import + wrap of `{children}`) to the app's layout file, exactly mirroring what the printed instructions tell a human to do; keep the existing `files.expected` assertion that the final layout contains the wrap. Add the stdout paste-lines assertion. The paste helper must be deliberately dumb (string-level, like the old codemod's minimal form) — it is simulating a user following instructions, not reintroducing a smart codemod.
- [ ] Step 4: `pnpm --filter @vendoai/corpus-harness test` green.
- [ ] Step 5: Commit: `corpus: harness applies the VendoRoot paste post-init (init no longer codemods layouts)`.

### Task 2: zod floors in ui + agent, plus guard rule (fix #2)

**Context:** `ai@6` imports `zod/v4` and declares peer `"zod": "^3.25.76 || ^4.1.8"`. Commit `174aa430` raised the zod floor in six packages but missed `@vendoai/ui` and `@vendoai/agent`, which declare `ai` as a peerDependency and carry NO zod entry; pnpm then peer-resolves ai against the host's stale zod (skateshop pins 3.23.8 → `ERR_PACKAGE_PATH_NOT_EXPORTED ./v4` during the host's own build post-injection).

**Files:** `packages/ui/package.json`, `packages/agent/package.json`, `scripts/dependency-guard.mjs` (+ its test if one exists), lockfile.

- [ ] Step 1: Verify empirically which zod 3.25.x patch first ships the `./v4` export (inspect the installed zod's exports map; the floor must guarantee the subpath — ai's own peer floor `^3.25.76` is the reference point).
- [ ] Step 2: Add `"zod"` to `dependencies` of `@vendoai/ui` and `@vendoai/agent` at that floor (match the declaration style of the six packages fixed in `174aa430`).
- [ ] Step 3: Extend `scripts/dependency-guard.mjs` with the rule: any workspace package declaring `ai` in peerDependencies must also declare a zod floor ≥ ai's zod peer floor. Write the guard test first if the script has a test harness; otherwise verify by temporarily breaking a package.json locally (do not commit the breakage).
- [ ] Step 4: `pnpm install` (lockfile update), `pnpm lint` (guard passes), `pnpm --filter @vendoai/ui test` and `pnpm --filter @vendoai/agent test` green.
- [ ] Step 5: Commit: `fix(deps): zod floor in ui+agent (ai peers zod/v4) + dependency-guard rule`.

### Task 3: pnpm-11 flags on the bootstrap install path (fix #3)

**Context:** `dcf8bee7` (pnpm-11 migration) added `--config.dangerouslyAllowAllBuilds=true` / `--config.minimumReleaseAge=0` accommodations only to `normalizePostInjectionInstallCommand` in `corpus/harness/src/install-command.ts`; the pre-injection `normalizeBootstrapInstallCommand` was never updated, so taxonomy/vercel-commerce/nextcrm/teable fail their first install under pnpm 11 (native build scripts like sharp/prisma blocked by strictDepBuilds).

**Files:** `corpus/harness/src/install-command.ts` + its tests.

- [ ] Step 1: Read both normalize functions; decide extend-vs-unify (prefer whichever keeps the two paths' EXISTING behavioral differences explicit — they differ on frozen-lockfile handling deliberately).
- [ ] Step 2: Failing tests first: bootstrap normalization of pnpm/corepack-pnpm commands gains the same pnpm-11 flags the post-injection path has, for each package-manager form the corpus manifest uses (pnpm, corepack pnpm, npm, yarn are all represented — npm/yarn forms must pass through unchanged).
- [ ] Step 3: Implement; `pnpm --filter @vendoai/corpus-harness test` green.
- [ ] Step 4: Commit: `corpus: bootstrap install path gets the pnpm-11 accommodations (missed by ENG-332)`.

### Task 4: scorecard-artifact diagnostic (fix #5)

**Context:** The `corpus-scorecard` artifact upload has found zero files since ≥Jul 17 ("No files were found with the provided path: corpus/.repos/.logs/scorecard.json") even though the sweep demonstrably writes and prints the scorecard. Code inspection says the write happens; the mismatch is likely path/cwd-shaped but unproven.

**Files:** `.github/workflows/corpus-nightly.yml`.

- [ ] Step 1: Read the workflow's sweep and upload steps; compare the artifact path against `writeScorecardArtifacts`'s actual output root (`corpus/harness/src/scorecard.ts` — check what `<corpusRoot>` resolves to when the harness runs via `pnpm --filter @vendoai/corpus-harness corpus`; a cwd difference between the harness process and the workflow's path expression is the prime suspect — if you can PROVE the mismatch from code, fix the path outright instead of only adding diagnostics).
- [ ] Step 2: Either fix the proven path mismatch, or add a diagnostic step after the sweep (`ls -laR corpus/.repos/.logs || true` plus echoing the resolved path) so the next nightly closes the question.
- [ ] Step 3: Commit: `ci: fix (or instrument) corpus scorecard artifact path`.

### Task 5: rallly confirmation rerun (open #4)

**Context:** rallly's bootstrap failure predates pnpm-11 (already failing Jul 17). Hypothesis: repo pins `engines.node: 24` while the workflow pins node 22. Fix only if confirmed.

- [ ] Step 1: After Tasks 1-3 land locally, run `pnpm corpus run rallly --layer 1` in this worktree (several minutes; clones + installs). Capture `corpus/.repos/.logs/rallly/bootstrap.stderr.log`.
- [ ] Step 2: If the engine mismatch is confirmed, bump `actions/setup-node`'s `node-version` in the nightly workflow to satisfy the pinned repos (verify no other corpus repo objects to the bump) and commit `ci: corpus nightly node version follows pinned repo engines`. If a different cause appears, report it instead of fixing blind.

### Task 6: verification sweep + PR

- [ ] Step 1: Local proof on the previously-failing classes: `pnpm corpus run taxonomy --layer 1` (bootstrap fixed + zod latent bug now surfacing or fixed) and `pnpm corpus run skateshop --layer 1` (zod fix) and one previously wrap-failing repo e.g. `pnpm corpus run invoify --layer 1` (harness paste). These are long (clone/install per repo); run sequentially, capture scorecards.
- [ ] Step 2: Repo gate: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`.
- [ ] Step 3: PR titled `corpus: restore the nightly to green-means-something (post-triage fixes)` — body lists the five root causes with commit refs, the two Yousef decisions, the local per-repo scorecard evidence, and the open leftover (invoify/cal-com/umami typechecks) with its own follow-up owner.

### Task 7 (parallel, investigation-only): invoify/cal-com/umami typechecks

- [ ] Dispatch a separate investigation using local Layer-1 reruns of invoify (smallest) to capture the real post-init typecheck stderr; classify root cause; report only (fixes are follow-up scope).

---

## Decisions locked during planning

- One PR for all triage fixes (they share the "make nightly meaningful" purpose); each fix its own commit.
- The harness paste helper is intentionally dumb string surgery — it simulates the documented user action, not a smart codemod.
- rallly and the typecheck leftover are confirm-first: no blind fixes.
