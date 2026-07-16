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
theme-color, favicon, a computed-style palette sample with named color roles
(`body-bg`, `header-bg`, `primary-button-bg`, `link`, ...), font evidence
(`fonts.families`/`faceSrcs`/`webfontLinks` — evidence only, never font
files), and downloaded logo/icon assets into `apps/demo-<id>/RESEARCH/`
(`research.json` + `page-*.png` + `assets/logo-*`, `assets/favicon-*`,
`assets/og-image.*`, ...).

- [ ] `research.json` exists and at least one page captured cleanly. Pages
      flagged `botChallenge: true` (or recorded as errors) are junk evidence —
      lean on provided screenshots instead. If only screenshots were supplied
      (no URL), copy them into `RESEARCH/` so the fidelity scoring in §3 has
      side-by-side evidence.
- [ ] **REAL APP SCREENS are mandatory reference material.** Provided
      screenshots first; if none show the actual product UI, find real
      product-UI imagery (marketing /product or /features pages, docs, press
      kits, public sandboxes/demos) and hand-capture it into `RESEARCH/`,
      recording provenance (what, from where, captured how) in
      `RESEARCH/README.md`. **The marketing homepage alone is NOT an
      acceptable reference for the rebuild.**
- [ ] **Confirm the logo landed.** `research.json` records every harvested
      asset under `pages[].assets` (source URL/element, saved path,
      dimensions); `RESEARCH/assets/` must contain a usable real logo (the
      header/nav SVG or img, or the SVG favicon). If the harvest missed it,
      hand-save one into `RESEARCH/assets/` and note the source in
      `RESEARCH/README.md` — §2.4 needs it and §3 hard-gates on it.
- [ ] `demo:research` cannot click through bot walls, cookie banners, or
      login/interstitial pages — it only loads URLs and screenshots them. For
      admin-only or gated surfaces, hand-drive a Playwright session (headed or
      MCP), save the screenshots into `RESEARCH/`, and note in
      `RESEARCH/README.md` which evidence was hand-captured and from where.

### 2.3 Study the evidence

- [ ] Read `RESEARCH/research.json` (`colorRoles`, palette
      `colors`/`fontFamilies`, `fonts`, `pages[].assets`, `themeColor`,
      titles) and LOOK at every screenshot. Decide, in writing (a scratch
      note is fine): primary/accent/background colors (exact values, mapped
      to tokens via `colorRoles`), font stack, corner radius language, nav
      structure (sidebar vs topbar, section names), and the prospect's
      domain vocabulary and copy voice.
- [ ] **Choose ONE reference screen** — the real product-UI screenshot the
      rebuild will clone structurally (§2.4) and be scored against (§3).
      Name it in the scratch note and in `RESEARCH/README.md`. It must show
      the actual product (app chrome, nav, real surfaces), not a marketing
      hero.

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
- [ ] **Pages — a STRUCTURAL 1:1 clone of the chosen reference screen.**
      Rewrite `src/app/page.tsx` (and any components/`globals.css` styling)
      to mirror the reference screen (§2.3) region by region: same regions,
      same nav items/labels, same column set, same header composition —
      populated from the seeded data. "Inspired by" layouts fail §3.
- [ ] **Logo** — copy the real logo from `RESEARCH/assets/` into the app
      (e.g. `public/`) and render it in the header/sidebar exactly where the
      product puts it. The demo is watermarked and sent to the brand owner
      themselves, so using their real logo inside the demo is a deliberate,
      accepted call — and it still never leaves the untracked app dir (§1).
- [ ] **Fonts** — use the REAL font when it's freely loadable (Google Fonts,
      rsms Inter, open-source); NEVER pirate licensed font files (e.g.
      Stripe's söhne) — closest freely-available metric match instead,
      documented. `research.json`'s `fonts` block names the families and
      where they load from; when a fallback was used, note the substitution
      and the license reason (one line) in `RESEARCH/README.md`.
- [ ] **Theme** — overwrite `.vendo/theme.json` with the prospect's brand
      tokens (colors, type, radius) using the EXACT values from
      `research.json` (`colorRoles` + palette; convert `rgb()` to hex, never
      eyeball); `src/vendo/theme.ts` just validates it at boot, leave it
      alone.
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

Score the finished demo against the **chosen reference screen** (§2.3) **side
by side**. Build the comparison artifact first — it is mandatory, not
optional:

- [ ] `RESEARCH/side-by-side.png` — the reference screen next to the rebuilt
      screen (`product.png` from §2.9). Any simple compositing works, e.g.:

      ```sh
      magick RESEARCH/<reference>.png bench/demo-capture/output/<id>-verify/product.png \
        +append RESEARCH/side-by-side.png
      # or: ffmpeg -i RESEARCH/<reference>.png -i .../product.png \
      #        -filter_complex hstack RESEARCH/side-by-side.png
      ```

**Hard gate — logo presence is PASS/FAIL, not scored.** The real logo (from
`RESEARCH/assets/`) renders in the header/sidebar where the product puts it.
**No logo = void run**; fix it before scoring anything.

Four dimensions, each 1–5. **Be harsh: every dimension starts at 3 and moves
only on visible evidence.** Ship bars ("would the prospect recognize this as
their product" — VERIFY.md §3): **Palette 5, Layout structure 5, Typography
≥4, Voice + tone ≥4.** A dimension below its bar gets fixed and re-scored,
not shipped with a caveat.

| Dimension | Below the bar | At the bar |
| --- | --- | --- |
| **Palette (bar: 5)** | A primary color that's "close" but not the sampled value; template neutrals surviving anywhere. | EXACT hexes from `research.json` (`colorRoles` + palette) on every token; the side-by-side shows zero hue drift. |
| **Layout structure (bar: 5)** | Same general shape but regions, nav items/labels, or columns differ from the reference screen; radius language wrong (sharp where they're soft). | STRUCTURAL 1:1 vs the chosen reference screen: same regions, same nav items/labels, same column set, same header composition. |
| **Typography (bar: 4)** | Generic system UI stack; weights/sizes don't match the prospect's hierarchy. | The REAL font when freely loadable, else the closest freely-available metric match with a one-line license note in the manifest; weight pairing and headings/body hierarchy mirror theirs. |
| **Voice + tone (bar: 4)** | Placeholder-ish copy ("items", "example"), or vocabulary from the wrong domain. | Every label and seeded string uses the prospect's domain terminology and register (formal/playful) as seen in the evidence. |

- [ ] The score table, with a one-line justification per row citing the
      specific evidence compared, plus the logo PASS/FAIL line, goes in the
      output manifest (§6).

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
- [ ] The brand-fidelity table (§3) with one-line justifications, the logo
      PASS/FAIL line, and the `RESEARCH/side-by-side.png` path (the §3
      comparison artifact).
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
