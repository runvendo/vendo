# B2: Theme Extraction — Exact Tokens + LLM Pass

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:test-driven-development per task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the theme-extraction guessing engine (`packages/vendo/src/cli/theme/`, ~1,400 lines of name-fragment scoring, utility popularity contests, and next/font source-recovery regexes) with the amended kill-list §B2 design: an allowlist fast-path over conventional shadcn/Tailwind tokens, plus one model call that fills whatever the allowlist could not read exactly. Authority: `docs/superpowers/specs/2026-07-16-simplify-v2-kill-list-design.md` §B2 (amended version).

**Quality gate:** measured slot accuracy on both demo apps (apps/demo-bank "Maple", apps/demo-accounting "Cadence") must beat the current baseline — target at least 6/7 scored slots correct on both, and no silent wrong-brand output: every slot the pipeline cannot read exactly or from the model is reported as defaulted, never quietly filled with a plausible guess.

**Scored rubric (fixed before any change):** seven brand-defining slots — accent, background, surface, text, mutedText, border, fontFamily — judged against ground truth read from each demo app's own source (its token sheet and dominant usage). Baseline is measured with this rubric on the current extractor before replacement and recorded in this plan; the same rubric scores the replacement.

**Model seam:** the extraction's model comes from the exact seam `vendo refine` already uses (model-import specifier, else the host's Anthropic key + installed provider). No new configuration is invented; a source comment notes that Vendo-hosted inference will swap in behind the same seam later. When no model resolves, extraction degrades to allowlist + defaults and says so — init never fails on theme.

## Task 1: Baseline measurement
- [ ] Run the current extractor against both demo apps and record per-slot results against the rubric's ground truth in this plan (the "before" column of the PR table).

## Task 2: Allowlist fast-path (tests first)
- [ ] Derive the definitive token allowlist from shadcn's documented theme variables (background/foreground, card, popover, primary, secondary, muted, accent, destructive, border, input, ring, radius, and the font-sans/serif/mono conventions), accepting both the bare and Tailwind-v4 `--color-*` prefixed spellings. Map only tokens whose shadcn semantic matches a Vendo slot; notably shadcn's "accent" (hover wash) is NOT Vendo's accent (brand primary).
- [ ] Keep `css-vars.ts` (honest small scanner) and `entry-candidates.ts` (shared list from the dup sweep) as the discovery layer; collect CSS from the root layout's imports with a bounded fallback scan.
- [ ] Exact value reading: resolve var chains and normalize hex / rgb / hsl (function and shadcn bare-triplet forms) / oklch to hex. Color-space conversion is deterministic published math, kept compact in one module — not guessing.
- [ ] Tests: a shadcn-convention fixture resolves every color slot exactly with zero model calls; partially conventional fixtures cover exactly what they declare.

## Task 3: LLM pass (tests first, mocked model)
- [ ] When the allowlist leaves slots unfilled, make ONE structured-output model call reading the collected CSS, the Tailwind config, and the root layout (all bounded), returning values only for slots the files actually evidence, plus a list of slots it is genuinely unsure about.
- [ ] Merge precedence: exact allowlist read > model > default; the model never overrides an exact read. Provenance recorded per slot (exact token name, model, or default).
- [ ] Tests use the ai SDK mock model (deterministic): merge precedence, uncertainty surfacing, model-unavailable degradation to defaults with honest reporting.

## Task 4: Delete the guessing machinery
- [ ] Delete `map-to-brand.ts` (fragment scoring lists, scale-accent picker, monochrome/tinted-bg rules), `next-fonts.ts` (source-recovery regexes, Tailwind neutral table), `workspace-resolve.ts`, and the utility popularity contest in `extract-theme.ts`. Default font stack + LLM/one-question covers fonts.
- [ ] `walk.ts` stays (framework detection uses it); `css-vars.ts` and `entry-candidates.ts` stay.

## Task 5: Init integration — editable theme.json + one-glance confirm
- [ ] Init resolves the model through the refine seam (failure degrades gracefully), skips extraction entirely when theme.json already exists and no force flag is given, and prints a one-glance palette summary (hex values, terminal swatches when interactive) after writing.
- [ ] Init asks a question ONLY for slots the model flagged uncertain — injectable prompt seam for tests, silent under --yes and non-TTY.
- [ ] theme.json remains the editable source of truth; the summary says so.

## Task 6: Accuracy gate + live test
- [ ] Deterministic demo-app test: the allowlist layer alone finds exactly the conventional tokens each app declares, and nothing else (no wrong-brand exact reads).
- [ ] Live test behind an env-gated skip (runs only with a real key present): full pipeline against both demo apps scored against the rubric; asserts at least 6/7 on each.
- [ ] Record the "after" accuracy in this plan and the PR table.

## Task 7: Gates and finish
- [ ] `pnpm --filter @vendoai/vendo test` and `typecheck` green per task; full `pnpm build && pnpm test && pnpm typecheck && pnpm lint` at the end.
- [ ] Contract check: `docs/contracts/09-vendo.md` already describes init as "deterministic + AI riding the dev's existing key" and does not encode the old heuristics — amend only if any wording contradicts the new pipeline.
- [ ] Push branch, open PR (no merge) with before/after accuracy table and net line count.

## Measurements

### Ground-truth correction (Task 6 finding)
The old test table's Cadence accent (#196b46 evergreen) was itself a silent
wrong brand: the Porcelain Ledger sheet demotes green to "data only" and the
app's primary Button is `bg-ink` — the true accent is the ink, #111111. Truth
table corrected before scoring both pipelines.

### Baseline (before)
Measured 2026-07-17 on the pre-B2 extractor with the seven-slot rubric
(accent, background, surface, text, mutedText, border, fontFamily):

- Maple (demo-bank): **7/7** (the fragment lists were tuned to this app).
- Cadence (demo-accounting): **5/7** — accent silently wrong (#196b46
  scale-accent green vs the app's ink #111111 CTAs) and mutedText silently
  wrong (`--color-ink-soft` #46443f vs the dominant `--color-ink-faint`
  #908c85, 59 vs 34 uses).
- Outside the rubric, Maple `motion` was silently wrong: the extractor read
  the app's `prefers-reduced-motion` accessibility override as a
  reduced-motion brand — the app animates.

### After
Measured 2026-07-17, exact-or-model pipeline through the real refine model
seam (claude-sonnet-4-6), three consecutive live runs plus a plain-node run
of the production seam:

- Maple (demo-bank): **7/7** — allowlist exact-reads `--color-border`; the
  model fills the rest, correctly treating the monochrome ink as the accent.
- Cadence (demo-accounting): **7/7** — allowlist exact-reads `--color-card`;
  the model correctly picks ink over the demoted green.
- No silent misses: every model doubt surfaces in `uncertain` (1-2 targeted
  questions on these non-conventional apps; conventional shadcn hosts are
  zero-model, zero-question), and unfillable slots land in `defaulted`.
