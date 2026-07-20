# Init AI Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One AI posture for `vendo init`: the theme LLM fallback becomes a stage of the consent-gated staged extraction pass, the devModel ladder leaves init, and the Agent SDK actually ships with the CLI so the pass works on any host.

**Architecture:** `extract-theme.ts` becomes fully deterministic (exact pass, validators, assembly) and exposes what the model half needs (needed slots, exact values, evidence paths). A new theme stage joins the staged pipeline in `stages.ts`, running only when core slots are unfilled. `init.ts` moves theme finalization (model merge, human answers, uncertain review, palette print) after the AI pass. The corpus nightly gains consent so it finally measures the full pipeline.

**Spec:** `docs/superpowers/specs/2026-07-20-init-ai-unification-design.md`

**Tech stack:** TypeScript, vitest, zod, `@anthropic-ai/claude-agent-sdk`, corpus harness, GitHub Actions.

**Working branch:** `yousefh409/theme-detect` (never commit to main; PR at the end).

**Verification bar (repo rule):** `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green before the PR.

---

### Task 1: Ship the Agent SDK with the CLI

**RESPEC 2026-07-20:** measurement killed the ship-the-SDK plan (~245 MB
native Claude Code binary per platform inside the SDK's platform packages,
hard-required by `query()`; `optionalDependencies` does not reduce it; zod-4
peer conflict). Decision (Yousef): do NOT ship the SDK. Add a PATH-CLI
harness instead.

**Files:**
- Create: `packages/vendo/src/cli/extract/claude-cli-harness.ts`
- Create: `packages/vendo/src/cli/extract/claude-cli-harness.test.ts`
- Modify: `packages/vendo/src/cli/extract/extraction.ts` (default harness list + unavailable message)

- [ ] **Step 1:** Write failing unit tests for a new `claudeCliHarness()` implementing the existing `ExtractionHarness` interface with injectable exec/probe seams (mirror `claude-harness.ts`'s seam style): (a) `availability` returns null when no `claude` binary is on PATH; (b) returns the key-credential string when the binary exists and `ANTHROPIC_API_KEY` is set; (c) returns the login-credential string when the binary exists and the login probe succeeds; (d) `run` invokes the binary headless with print mode, the instructions as the prompt, read-only allowed tools (Read/Glob/Grep), everything else disallowed, default permission mode, isolated settings, host root as cwd, caller env forwarded, and honors `VENDO_EXTRACTION_MODEL`; (e) `run` returns stdout on success and throws with stderr context on nonzero exit.
- [ ] **Step 2:** Run them, confirm they fail (module does not exist): `pnpm --filter @vendoai/vendo exec vitest run src/cli/extract/claude-cli-harness.test.ts`
- [ ] **Step 3:** Implement the harness. Verify real flag spellings against the locally installed binary (`claude --help`); the repo's own nightly uses `claude -p ... --allowedTools ... --permission-mode ...` as prior art. Generous subprocess timeout (stages can run minutes). Reuse the login-probe approach from `claude-harness.ts` rather than duplicating logic where reasonable.
- [ ] **Step 4:** Register it in `runAiExtraction`'s default harness list AFTER the Agent SDK harness (SDK preferred when resolvable, CLI as fallback), and update the unavailable message to name the real remedies: install Claude Code (`npm install -g @anthropic-ai/claude-code`) or make the Agent SDK resolvable, plus a credential (Claude Code login or `ANTHROPIC_API_KEY`).
- [ ] **Step 5:** Run the extraction unit tests: `pnpm --filter @vendoai/vendo exec vitest run src/cli/extract/`. Expected: green. Then `pnpm --filter @vendoai/vendo typecheck`.
- [ ] **Step 6:** Commit ("feat(extract): claude PATH-CLI harness — AI pass without shipping the 245MB Agent SDK").

### Task 2: Make extract-theme.ts fully deterministic

**Files:**
- Modify: `packages/vendo/src/cli/theme/extract-theme.ts`
- Modify: `packages/vendo/src/cli/theme/css-vars.ts:12-18`
- Test: `packages/vendo/src/cli/theme/extract-theme.test.ts`

- [ ] **Step 1:** Update `extract-theme.test.ts` first (TDD): remove every `resolveModel` fixture; add assertions that the summary now carries the list of slots the exact pass could not fill (`needed`) and the evidence file paths the context gatherer collected; add tests for a new exported reassembly helper that merges validated model slot values and uncertainty into an exact-pass summary (exact reads win, model fills gaps, accentText re-derives by contrast when the model supplies an accent, headingFamily inherits, remaining slots stay defaulted, uncertainty filtered to reviewable slots the exact pass left open).
- [ ] **Step 2:** Run the file, confirm the new tests fail: `pnpm --filter @vendoai/vendo exec vitest run src/cli/theme/extract-theme.test.ts`
- [ ] **Step 3:** Implement: delete `modelPass`, the `generateObject`/`ai`/`LanguageModel` imports, `ExtractThemeOptions.resolveModel` (and the now-empty options object if nothing remains); extend the summary with `needed` and evidence paths; extract the existing assembly loop into the exported reassembly helper so `extractTheme` (exact-only) and the post-stage merge share one implementation. Export `modelThemeSchema` (currently module-private) — the stage will import it. Rewrite the stale header comment (it still references the refine seam). Baseline note (post commit 576a3cfb): the core-slot list is named `BRAND_SLOTS` and `DEFAULT_THEME_SLOTS` is no longer exported; the dead `synthetic`/`inferred` fields were already removed upstream — no action.
- [ ] **Step 4:** Run theme unit tests, confirm green. Then `pnpm --filter @vendoai/vendo typecheck` to catch downstream users of the removed option (init.ts will fail — expected; note it and fix in Task 4, or stub the call site minimally to keep the package compiling before commit).
- [ ] **Step 5:** Commit ("refactor: extract-theme goes fully deterministic; model half moves to the extraction stage").

### Task 3: Add the theme stage to the staged pipeline

**Files:**
- Modify: `packages/vendo/src/cli/extract/stages.ts`
- Test: `packages/vendo/src/cli/extract/stages.test.ts`

- [ ] **Step 1:** Write failing tests in `stages.test.ts` using the existing scripted-harness pattern: (a) when theme input has unfilled core slots, a theme stage runs after brief and its parsed artifact lands in the result plus `.vendo/data/extract/theme.json`; (b) when the exact pass filled everything, no theme stage call happens at all; (c) a theme stage failure degrades to a note, never throws, and the rest of the staged result is intact; (d) when no theme input is provided (callers other than init, e.g. `vendo extract --apply` today), behavior is unchanged.
- [ ] **Step 2:** Run: `pnpm --filter @vendoai/vendo exec vitest run src/cli/extract/stages.test.ts`. Expected: the new tests fail.
- [ ] **Step 3:** Implement: a theme-instructions composer (inputs: needed slots, already-exact values, evidence file paths as starting hints, app name; rules ported verbatim from the old model system prompt — status colors never the accent, monochrome brands, next/font semantics, no invented values, uncertainty only on genuine forks, reply as one fenced json block matching the theme schema); an optional theme input on `StagedExtractionInput`; the stage itself in `runStagedExtraction` after brief, gated on non-empty needed core slots, artifact validated against the imported `modelThemeSchema`, failure degrading with a note. The result type gains the optional raw theme draft. Add two rules the 2026-07-19 corpus triage proved necessary: the BODY font is the Tailwind `sans`/`default` fontFamily key (a `display` face goes to headingFamily, never fontFamily — the dub miss), and the `geist` npm package's `GeistSans`/`GeistMono` imports are font sources just like next/font (the skateshop miss).
- [ ] **Step 4:** Run stages tests, confirm green.
- [ ] **Step 5:** Commit ("feat: theme stage in the staged extraction pipeline").

### Task 4: Rewire init — consent-gated theme, finalization after the pass

**Files:**
- Modify: `packages/vendo/src/cli/init.ts` (theme block ~1303-1356, AI pass call ~1394-1408, the theme resolver near line 180, unused imports)
- Modify: `packages/vendo/src/cli/extract/extraction.ts` (`runAiExtraction` options/result, consent prompt text)
- Test: `packages/vendo/src/cli/init.test.ts` (or the existing init test file), `packages/vendo/src/cli/extract/extraction.test.ts`

- [ ] **Step 1:** Write failing tests for the new init semantics: (a) consent declined or non-interactive without `--ai-polish` → theme.json holds exact reads plus visible defaults, no model involvement; (b) consent granted with a scripted harness returning theme values → theme.json holds the merged result, provenance shows model-filled slots; (c) a `--theme slot=value` answer beats a model value for the same slot; (d) uncertain-slot review runs after the pass and only for reviewable slots the model flagged; (e) a pre-existing theme.json is untouched even with consent; (f) the consent prompt mentions theme.
- [ ] **Step 2:** Run the init and extraction test files, confirm the new tests fail.
- [ ] **Step 3:** Implement in `extraction.ts`: `runAiExtraction` accepts the optional theme input, threads it into `runStagedExtraction`, returns the raw theme draft alongside `ran`; consent prompt text extended to cover theme ("…and fill unresolved theme slots"). The overrides/brief apply path is unchanged.
- [ ] **Step 4:** Implement in `init.ts`: main flow calls the now-deterministic `extractTheme`, writes the exact-only theme.json (existing never-overwrite law unchanged), and records whether init created the file this run. Delete the theme model resolver and its devModel usage (init's key-step credential detection stays untouched; remove only imports that become unused). After `runAiExtraction`: validate each drafted slot with `validateSlotValue`, accept only slots the exact pass left open, merge via the Task 2 reassembly helper, apply `--theme` answers and the human-override/accentText re-derivation logic (move the existing block, do not duplicate it), rewrite theme.json only if init created it this run, print the palette summary once (after finalization, not before), then the uncertain review. The `themeModel` test seam on `InitOptions` is replaced by the scripted-harness seam.
- [ ] **Step 5:** Run both test files plus the whole package: `pnpm --filter @vendoai/vendo test`. Expected: green.
- [ ] **Step 6:** Run `pnpm typecheck`. Expected: green (Task 2's temporary stub, if any, is now resolved).
- [ ] **Step 7:** Commit ("feat: init theme finalization rides the consent-gated AI pass; devModel ladder leaves init").

### Task 5: Port the live accuracy gate

**Files:**
- Modify: `packages/vendo/src/cli/theme/extract-theme.live.test.ts`

- [ ] **Step 1:** Rewrite the live test to exercise the new path: exact pass on each demo app, then — when core slots are unfilled — the theme stage through the real `claudeHarness` with `ANTHROPIC_API_KEY` (keep the existing skip-without-key gate). Score with the same fixed rubric: at least 6/7 brand slots per app, any miss visible in defaulted/uncertain, never a silent wrong value.
- [ ] **Step 2:** Run it live with the key from `/Users/yousefh/orca/workspaces/flowlet/.env`: `pnpm --filter @vendoai/vendo exec vitest run src/cli/theme/extract-theme.live.test.ts`. Expected: 2/2 pass. If a demo app now scores below the gate, that is a real regression in the stage prompt — fix the instructions composer, not the rubric.
- [ ] **Step 3:** Commit ("test: live theme gate rides the harness path").

### Task 6: Corpus wiring and evidence

**Files:**
- Modify: `corpus/harness/src/init-step.ts:65-69` (init args)
- Modify: `corpus/harness/src/init-step.test.ts` (or wherever init-step args are asserted)
- Modify: `.github/workflows/corpus-nightly.yml:85-108` (sweep step)
- Possibly modify: `corpus/expectations/<repo>/expected.json` for umami, cal-com, formbricks, openstatus
- Modify: `corpus/README.md` (document the consent flag in the sweep)

- [ ] **Step 1:** Context (from the 2026-07-20 triage): the harness already injects `@ai-sdk/anthropic` into every clone (`local-pack.ts`), so the theme model pass ALREADY runs nightly. Once theme moves behind consent, the sweep MUST pass the consent flag or that coverage regresses — this task is regression-prevention, not just new coverage. Add an option to the corpus init step that appends `--ai-polish` to the init invocation; assert it in the init-step unit test; wire the Layer 1/2 sweep to enable it (the workflow already exports `ANTHROPIC_API_KEY`). Do NOT remove the `@ai-sdk/anthropic` injection in this program — harness injection is another lane's surface (2026-07-20 split); leave a follow-up note instead. Run harness unit tests: `pnpm --filter @vendoai/corpus-harness test`.
- [ ] **Step 2:** Local evidence run against the four defaulted repos: `pnpm corpus run umami cal-com formbricks openstatus --layer 2 --json` with the key exported. Capture per-repo theme scores before/after (before: 2/7 each, from the 2026-07-19 nightly — with the model already running, so these are quality gaps the stage must beat, not coverage gaps).
- [ ] **Step 3:** Re-baseline decision per repo, evidence-driven: compare each remaining miss against the repo's actual source ground truth. Fix an `expected.json` value only when the expectation itself is verifiably wrong (cite the source file in the commit message). A model value that disagrees with ground truth stays a miss — expectations are never bent toward model output. Scores stay informational (no gate change). Already done on this branch during triage: inbox-zero fontFamily expectation completed to the full ground-truth stack; invoify fontFamily fixed extractor-side (quote normalization).
- [ ] **Step 4:** Update `corpus/README.md` with one paragraph: the sweep runs init with AI consent; what that exercises; the credential it needs.
- [ ] **Step 5:** Commit ("corpus: sweep consents to the AI pass; theme evidence re-baselined where expectations were wrong").

### Task 7: Docs sync and full gates

**Files:**
- Modify: whatever `grep -rn "theme" docs/ --include="*.md" -l` and the init docs surface as stale (candidates: init/theme integration docs mentioning the model resolution or key behavior)
- No docs-site changes unless the same grep hits `docs-site/`

- [ ] **Step 1:** Grep docs for descriptions of theme extraction's model behavior and the AI-polish credential story; update the stale ones (succinct, direct). The consent prompt now covers theme; the SDK ships with the CLI; `ANTHROPIC_API_KEY` or Claude Code login is the whole credential story for init AI.
- [ ] **Step 2:** Run the full bar: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`. Expected: all green. Fix anything red before proceeding.
- [ ] **Step 3:** Commit ("docs: init AI story reflects the unified pass").

### Task 8: PR

- [ ] **Step 1:** Push `yousefh409/theme-detect` and open a PR against main titled "init AI unification: theme rides the staged extraction pass". Body: link the spec, the corpus before/after theme scores from Task 6 as evidence, the SDK weight measurement from Task 1, and note that no UI surface changed (no browser evidence required under the repo rule).
- [ ] **Step 2:** Confirm CI green on the PR (ci, integration, conformance jobs). Do not merge without Yousef.
