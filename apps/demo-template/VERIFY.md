# VERIFY.md — the demo-creator's contract

A generated demo (a clone of this template, rewritten for one prospect) does
NOT count as done until every item below passes. This is a checklist to
execute, not to eyeball. Never relax a mark, an `expectsView`/`expectsApproval`
declaration, or a beat definition in order to make a run pass — if a beat
can't legitimately hit its mark, fix the demo, don't lower the bar.

## 1. Build and boot

- [ ] `pnpm build --filter <app>` (or `--filter demo-template` while working
      in the template itself) is green.
- [ ] `pnpm dev` boots the app; open `/vendo` in a real browser.
- [ ] Zero console errors on load (check the browser devtools console, not
      just that the page rendered).

## 2. `demo-beats` capture — the recording IS the verification

Run the generic capture adapter against the demo's own directory:

```sh
pnpm --filter @vendoai/bench demo:capture -- demo-beats \
  --host-config apps/<app> --run-id <demo-id>-verify
```

- [ ] The capture command exits successfully. It fails the run (not just logs
      a warning) if any beat doesn't settle, or if a beat with a declared
      `expectsView`/`expectsApproval` doesn't visibly deliver it.
- [ ] Every beat in `demo.config.json`'s `beats[]` has the expectation that
      matches what it's supposed to prove: the UI-generation beat sets
      `expectsView: true`; the action beat that should show a consent card
      sets `expectsApproval: true`. Do not add expectations a beat can't meet
      to force a pass, and do not drop an expectation to dodge a failure —
      fix the prompt or the fake-API wiring instead.
  - Reference from this template's own sample beats
    (`demo.config.json`): `generate-ui` (`expectsView`), `take-action`
    (`expectsApproval`), `save-app` (no expectation — an action-only beat
    that settles without generating a new view).
- [ ] Inspect the produced `capture.json` (per-beat `overlay` marks:
      `firstPaintMs`, `usableMs`, `elapsedMs`, `approvals`) and the GIF
      (`demo-beats-<demo-id>.gif`) at the run root — read them, don't just
      confirm the files exist.
- [ ] This GIF (or a downscaled copy of it) is the artifact that ships with
      the demo link for review — not a separately staged recording.

## 3. Brand fidelity self-score

- [ ] Side by side, compare the demo's own `demo-beats` screenshots (or
      frames pulled from the GIF) against the prospect's source screenshots
      (site crawl and/or supplied dashboard images). Score explicitly on:
  - **Palette** — primary/accent/background colors match the prospect's,
    not the template's neutral default theme.
  - **Type** — font family and weight pairing reads as the prospect's, not
    generic system UI.
  - **Radius** — corner rounding on cards/buttons matches the prospect's
    visual language (sharp vs. soft).
  - **Nav structure** — the shell's navigation (sidebar vs. topbar, section
    names, ordering) mirrors how the prospect's real product is organized.
  - **Tone** — copy voice (formal/playful, terminology) matches the
    prospect's domain vocabulary, not placeholder "item"/"example" language.
- [ ] Any dimension that doesn't clear a plain "would the prospect recognize
      this as their product" bar gets fixed before shipping, not noted as a
      caveat.

## 4. Uncanny-data pass

- [ ] Seed data (`src/server/seed.ts` and equivalents) is plausible for the
      prospect's domain: right order of magnitude for amounts/counts,
      realistic-sounding names/entities, dates that make sense for the
      domain's cadence. No `Foo`/`Bar`/`Lorem ipsum`/`Alpha`/`Bravo`-style
      placeholder tokens left over from the template's example data.
- [ ] The demo chrome badge (`"[Prospect] demo · built with Vendo · sample
      data"`) and the fake-data framing are intact and visible on load — the
      creator must not remove or restyle this text away, only re-theme its
      container.

## 5. Caps and expiry

- [ ] `demo.config.json`'s `caps.maxTurns` and `caps.maxSpendUsd` are set
      (template sample: 20 turns / $5 — adjust per prospect risk if needed,
      never remove).
- [ ] `expiresAt` is set to a real future date for this prospect's outreach
      window (not the template sample's far-future placeholder).
- [ ] `.vendo/data/demo-caps.json` (the persisted turn/spend counters) does
      NOT exist at ship time — delete it before handoff so the prospect gets
      a fresh cap budget. Its presence with nonzero counters means the
      verification run itself ate into the prospect's live caps.

## 6. Three-strikes rule

- [ ] If the same beat fails verification 3 times in a row (capture rejects
      it, or a fix attempt still doesn't hit its mark), STOP. Do not ship,
      do not relax the beat's expectation to force a pass. Escalate to
      Yousef with the failing `capture.json`/GIF and what was tried.

---

Never ship a demo where any box above is unchecked. When every box is
checked, the GIF from step 2 and the screenshots from step 3 are what
travel with the demo link for review.
