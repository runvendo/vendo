# PLAYBOOK.md — the demo-creator agent's contract

This is the document a fresh agent session follows to turn a prospect (name +
URL and/or screenshots) into a verified demo app. It is a CONTRACT like
`apps/demo-template/VERIFY.md`, not prose: execute every stage in order, check
every box, and treat VERIFY.md as the definition of done. Where the two
disagree, VERIFY.md wins.

## 1. Inputs and invariants

Inputs:

- **Prospect name** (display name, e.g. "Linear").
- **Prospect URL** and/or **provided screenshots** of their product. At least
  one of the two; both is better.
- Optional notes (domain hints, which product surface to imitate, CTA link).

Invariants — violating any of these voids the run:

- [ ] **ALL seed data is invented.** No real people, real names, real emails,
      real amounts, or real records from the prospect's site, screenshots, or
      any other source material. Evidence informs *style*, never *data*.
- [ ] **Prospect branding appears only inside the watermarked demo** — the app
      whose chrome shows the "[Prospect] demo · built with Vendo · sample
      data" badge. Never in tracked repo files, commit messages, or anywhere
      the badge doesn't travel with it.
- [ ] **The fenced plumbing is never modified.** Concretely, in the generated
      app these files/parts are off-limits (each carries an in-file banner):
  - `src/server/caps.ts` — the caps guard (the only thing bounding cost on
    our Anthropic key).
  - `src/app/api/vendo/[...vendo]/route.ts` — the guard wrapper route.
  - `src/app/demo-status/route.ts` — the read-only caps poll.
  - `src/vendo/server.ts` — the model wrapping (`wrapLanguageModel` +
    `spendMeteringMiddleware`) is untouchable; the host-component catalog in
    the same file is a creator seam but **stays empty this milestone**.
  - `src/components/demo-chrome.tsx` — badge, CTA, limit/expired card
    (re-theme its container only; never remove or restyle the text away).
  - `src/components/suggestion-chips.tsx` — beat chips (edit
    `demo.config.json`'s `beats`, not this file; see its SEAM NOTE).
  - `src/app/vendo/page.tsx` and `src/components/demo-panel.tsx` — restyle,
    don't rewire: the wiring documented in their banners is load-bearing.
  - `src/lib/demo-config.ts` + `src/lib/demo-config-loader.ts` — the schema
    the capture harness imports via the `demo-template/demo-config` export.
  - `package.json`'s `predev`/`prebuild` `vendo sync .` scripts, and the
    `/vendo` panel route path (the capture harness assumes it).
- [ ] **The demo stays an untracked scratch app.** Commit nothing: not the app
      directory, not `pnpm-lock.yaml`, not RESEARCH evidence. `git status` at
      the end must show only the app dir as untracked (§7).
- [ ] Never relax a beat expectation, a stopwatch mark, or a cap to make
      verification pass (VERIFY.md's standing rule).

## 2. Stage order

Run everything from the repo root. Preconditions once per session:

```sh
node --version   # must be >= 23.6 (demo:create and demo-beats --host-config
                 # load the template's TypeScript schema via type stripping)
pnpm install && pnpm build
pnpm --filter @vendoai/bench exec playwright install chromium  # once
# ffmpeg + ffprobe must be on PATH (GIF conversion)
set -a
source /Users/yousefh/orca/workspaces/flowlet/.env   # ANTHROPIC_API_KEY
set +a
```

### 2.1 Create

```sh
pnpm --filter @vendoai/bench demo:create -- \
  --id <slug> --prospect "<Name>" --url https://<prospect-site> \
  [--cta-url URL] [--target-dir apps]
pnpm install   # link the new workspace app (dirties pnpm-lock.yaml; reverted in stage 8)
```

`--id` must be lowercase alphanumeric segments joined by single hyphens
(validated against the template's own schema before anything touches disk).
This clones `apps/demo-template` → `apps/demo-<id>`, renames the package to
`demo-<id>`, writes a `demo.config.json` skeleton whose beat prompts/chips are
fenced with a `TODO(creator): ` prefix, and leaves `RESEARCH/README.md`.

- [ ] `apps/demo-<id>` exists and `pnpm install` linked it.

### 2.2 Research

```sh
pnpm --filter @vendoai/bench demo:research -- \
  --app apps/demo-<id> --url https://<prospect-site> [--url https://<more-pages>]
```

Captures per-URL viewport + full-page screenshots, page title, meta
theme-color, favicon, and a computed-style palette sample into
`apps/demo-<id>/RESEARCH/` (`research.json` + `page-*.png`).

- [ ] `research.json` exists and at least one page captured cleanly. Pages
      flagged `botChallenge: true` (or recorded as errors) are junk evidence —
      lean on provided screenshots instead. If only screenshots were supplied
      (no URL), copy them into `RESEARCH/` so the fidelity scoring in §3 has
      side-by-side evidence.
- [ ] `demo:research` cannot click through bot walls, cookie banners, or
      login/interstitial pages — it only loads URLs and screenshots them. For
      admin-only or gated surfaces, hand-drive a Playwright session (headed or
      MCP), save the screenshots into `RESEARCH/`, and note in
      `RESEARCH/README.md` which evidence was hand-captured and from where.

### 2.3 Study the evidence

- [ ] Read `RESEARCH/research.json` (palette `colors`/`fontFamilies`,
      `themeColor`, titles) and LOOK at every screenshot. Decide, in writing
      (a scratch note is fine): primary/accent/background colors, font stack,
      corner radius language, nav structure (sidebar vs topbar, section
      names), and the prospect's domain vocabulary and copy voice.

### 2.4 Rewrite the visible product

Replace the template's placeholder `items` example with prospect-domain
surfaces. The worked example to imitate is the template's own
`src/server/` + `src/app/api/items/` pattern.

- [ ] **Entity layer** — rewrite `src/server/types.ts`, `store.ts`, `seed.ts`,
      and `items.ts` (rename to the domain entity) keeping the pattern:
      deterministic seed (keep `prng.ts`), in-memory store, list + one
      mutating action. `caps.ts` and `http.ts` stay. Update
      `src/server/__tests__/` to match.
- [ ] **API routes + tools** — replace `src/app/api/items/...` with the domain
      routes, declare them in `openapi.json`, then regenerate the agent tools:

      ```sh
      pnpm --filter demo-<id> exec vendo sync .
      ```

      (also runs automatically on `predev`/`prebuild`). Confirm
      `.vendo/tools.json` lists the new operations.
- [ ] **Pages** — rewrite `src/app/page.tsx` (and any components/`globals.css`
      styling) into the fake product surface: the prospect's layout structure,
      nav, and voice, populated from the seeded data.
- [ ] **Theme** — overwrite `.vendo/theme.json` with the prospect's brand
      tokens (colors, type, radius); `src/vendo/theme.ts` just validates it at
      boot, leave it alone.
- [ ] **Host-component catalog stays empty** — both the catalog in
      `src/vendo/server.ts` and `src/vendo/host-components.tsx`.

### 2.5 Author the beats

Edit `apps/demo-<id>/demo.config.json`:

- [ ] Replace **every** `TODO(creator): ` prefix (prompts AND chips). Check:

      ```sh
      grep -n "TODO(creator)" apps/demo-<id>/demo.config.json   # must return nothing
      # (RESEARCH/README.md may legitimately keep its TODO when no --url was given)
      ```
- [ ] Keep the fixed 3-beat arc and its expectation declarations verbatim:
  1. `generate-ui` — a UI-generation prompt over the seeded domain data,
     `expectsView: true`. **The prompt must be IMPERATIVE** — "Build me a
     dashboard of X — show Y and Z", not a question. Question-form prompts
     ("Can you show me...?", "What do my orders look like?") get answered as
     markdown with no generated view and fail the `expectsView` declaration
     (this struck the Shopify run).
  2. `take-action` — a consented mutating action, `expectsApproval: true`.
     **The prompt must name a specific seeded record** — the template's
     precedent is "Archive the item named Bravo" — so the agent acts
     immediately instead of asking a clarifying question (a clarifying-answer
     turn settles with no approval card and fails the declaration).
  3. `save-app` — save the generated view as a reusable app; no expectation.
- [ ] `caps.maxTurns`/`caps.maxSpendUsd` stay set (template sample 20/$5;
      adjust per risk, never remove). Set `expiresAt` to a real future date
      for this prospect's outreach window, not the sample's 2099 placeholder.

### 2.6 Chips sanity

- [ ] Each `beats[].chip` is a short label (the chip strip), each
      `beats[].prompt` is the full sentence (the empty-landing suggestions);
      chips read naturally in the prospect's vocabulary.

### 2.7 Local boot check — never port 3000

Port 3000 belongs to the capture harness's shared lock
(`/tmp/vendo-l3-port3000.lock`) and other Layer-3 runs; always pick another.

```sh
pnpm --filter demo-<id> dev --port 3150
```

(No `--` before `--port`: pnpm already forwards unknown flags to the script,
and with `--` the literal `--port` reaches `next dev` as a positional arg,
which Next treats as a project directory and fails.)

- [ ] Open `http://localhost:3150` (product page) and
      `http://localhost:3150/vendo`: badge + CTA visible, 3 chips render,
      zero devtools console errors on load.
- [ ] Kill the dev server before capturing — the capture boots the app itself.

### 2.8 Verify — the demo-beats capture IS the verification

```sh
pnpm --filter @vendoai/bench demo:capture -- demo-beats \
  --host-config apps/demo-<id> --run-id <id>-verify --port 3151
```

The capture deletes the app's `.vendo/data/demo-caps.json` at start (fresh
local caps), boots the app via its own `pnpm dev`, runs the beats in ONE
continuous recording, auto-approves consent cards, and FAILS the run if any
beat doesn't settle or any declared `expectsView`/`expectsApproval` isn't
visibly delivered.

- [ ] The command exits 0.
- [ ] READ `bench/demo-capture/output/<id>-verify/<id>/capture.json` (each beat
      records `approvals` plus its overlay marks — `firstPaintMs`, `usableMs`,
      `elapsedMs` — nested under the beat's `overlay` object) and WATCH
      `bench/demo-capture/output/<id>-verify/demo-beats-<id>.gif`. Don't just
      confirm the files exist.
- [ ] On failure, apply §5 (three strikes).

### 2.9 Static screenshots

- [ ] Capture 2 stills into `bench/demo-capture/output/<id>-verify/`:
      `product.png` (the rewritten product page) and `panel.png` (`/vendo`
      with chrome + chips). Any method works (Playwright script, headed
      browser); boot on a non-3000 port as in §2.7 and kill the server after.

Then run §3 (fidelity score) and §4 (uncanny-data pass), write the manifest
(§6), and clean up (§7).

## 3. Brand-fidelity self-score

Score the finished demo against the `RESEARCH/` evidence **side by side**
(demo screenshots/GIF frames next to `RESEARCH/page-*.png` or provided
screenshots). Four dimensions, each 1–5. **Be harsh: every dimension starts at
3 and moves only on visible evidence.** The ship bar is 4 on every dimension
("would the prospect recognize this as their product" — VERIFY.md §3); a
dimension below 4 gets fixed and re-scored, not shipped with a caveat.

| Dimension | 2 looks like | 4 looks like |
| --- | --- | --- |
| **Palette** | Template neutrals survive, or a primary color that's "close" but visibly the wrong hue next to the prospect's screenshot. | Primary/accent/background sampled from the evidence; a squint test on the side-by-side can't tell which panel is whose. |
| **Typography** | Generic system UI stack; weights/sizes don't match the prospect's hierarchy. | Font family (or its closest available stand-in) and weight pairing read as the prospect's; headings/body hierarchy mirrors theirs. |
| **Layout structure** | Template's single-column placeholder layout with renamed labels; radius language wrong (sharp where they're soft). | Nav placement (sidebar vs topbar), section names/ordering, card/button radius all mirror how the prospect's real product is organized. |
| **Voice + tone** | Placeholder-ish copy ("items", "example"), or vocabulary from the wrong domain. | Every label and seeded string uses the prospect's domain terminology and register (formal/playful) as seen in the evidence. |

- [ ] The score table, with a one-line justification per row citing the
      specific evidence compared, goes in the output manifest (§6).

## 4. Uncanny-data pass

Read `src/server/seed.ts` (and every seeded string that renders) and check:

- [ ] **Magnitudes** — amounts/counts are the right order of magnitude for the
      domain (a payments demo isn't full of $3 charges; an issue tracker
      doesn't have 40,000 open issues in a 5-person workspace).
- [ ] **Name plausibility** — invented people/companies/records sound real for
      the domain and are not copied from any source material.
- [ ] **Date coherence** — dates cluster the way the domain's cadence would
      (recent activity recent, no records dated after today, sequences in
      order: created < updated < closed).
- [ ] **No placeholder tokens** — zero `Foo`/`Bar`/`Test`/`Lorem`/`Alpha`/
      `Bravo`-style leftovers:

      ```sh
      grep -rniE "foo|bar|lorem|alpha|bravo|placeholder|example" apps/demo-<id>/src/server/seed.ts
      ```

      (audit each hit; legitimate domain words can stay).
- [ ] **Category distribution sane** — statuses/types spread realistically,
      not one of each enum value in order, not everything "active".

## 5. Three-strikes rule

Per failing beat in a `demo-beats` run:

1. **Diagnose the real cause** — read the capture error, the app's
   `server.log` in the run directory, and the GIF around the failure. Name
   the cause (prompt ambiguity, missing tool, seed mismatch, broken route)
   before touching anything.
2. **Fix that cause** — in the prompt, seed, or fake-API wiring.
3. **Re-run** the same capture command (use a fresh `--run-id` per attempt so
   evidence isn't overwritten).

After **3 failures of the same beat**, STOP. Do not ship; do not relax
`expectsView`/`expectsApproval`, marks, or caps to force a pass. Escalate with
the failing `capture.json`, the GIF, and a list of what was tried.

## 6. Output manifest

A finished run produces `bench/demo-capture/output/<id>-verify/MANIFEST.md`
containing, with real paths:

- [ ] App directory path (`apps/demo-<id>`).
- [ ] Capture GIF path + `capture.json` path (from the passing §2.8 run).
- [ ] The 2 static screenshot paths (§2.9).
- [ ] The brand-fidelity table (§3) with one-line justifications.
- [ ] Uncanny-data pass confirmation (§4).
- [ ] **Frictions list** — every point where this playbook or the tooling made
      the run harder than it should be (missing flags, manual steps, unclear
      contracts). This feeds the next milestone's automation; an empty list
      from a first run is suspicious.

## 7. Cleanup

- [ ] Kill every server the run started (the capture cleans up its own boot;
      check the manual ones): `lsof -ti tcp:<port> | xargs kill` for each
      port used.
- [ ] Delete `apps/demo-<id>/.vendo/data/demo-caps.json` — the verification
      run consumed the demo's own capped turns (VERIFY.md §5).
- [ ] `git checkout pnpm-lock.yaml` — revert the install-time lockfile drift.
- [ ] `git status` shows ONLY `apps/demo-<id>/` as untracked and nothing
      modified. Commit nothing.

## 8. Deploy — separate step, after verification

Deployment is NOT part of the creator run: the session ends at VERIFIED (or
escalates), and whoever operates the pipeline (Yousef, or the mini's
`demo-creator` skill — `docs/gtm/demo-creator-skill/SKILL.md`) deploys the
verified app:

```sh
set -a
source /Users/yousefh/orca/workspaces/flowlet/.env   # ANTHROPIC_API_KEY
set +a
export ROUTER_ADMIN_TOKEN="$(cat ~/.vendo/demo-router-admin-token)"
pnpm --filter @vendoai/bench demo:deploy -- --app apps/demo-<id>
```

`demo:deploy` renders a Dockerfile/.dockerignore into the app, syncs the
lockfile, ships one Railway service (`demo-<id>` in project `vendo-demos`)
from the working tree — untracked scratch apps deploy without committing —
sets `ANTHROPIC_API_KEY` on the service, and registers the demo with the
demos.vendo.run router (`Live at https://demos.vendo.run/<id>`). Both
secrets are required and never logged; `--dry-run` prints the redacted
plan. Expiry teardown is `demo:reap` (dry-run by default, `--execute` to
tear down).
