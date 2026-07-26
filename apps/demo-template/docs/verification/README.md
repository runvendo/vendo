# Verification media

Committed evidence for milestone 1 (demo-template + generic `demo-beats`
capture adapter). Sourced from local browser runs and the `demo-beats`
acceptance capture against the template's own `demo.config.json`
(`id: template-sample`); downscaled/re-encoded for PR review — full-res
originals are gitignored under `bench/demo-capture/output/`.

## Files

- **`demo-beats-acceptance.gif`** (~7.8 MB, 720px wide, 8 fps) — the
  acceptance recording from `demo-beats --host-config apps/demo-template
  --run-id task6-acceptance`, re-encoded from the original 12.6 MB / 960px /
  10 fps capture so GitHub renders it inline. This IS the verification
  artifact per `VERIFY.md` §2: one continuous recording of all three
  `demo.config.json` beats running against a live boot of the app, with the
  stopwatch overlay and per-beat marks burned in. Measured timings from the
  run's `capture.json`:
  - `generate-ui` (`expectsView`): first paint **13.6s**, usable **76.1s**.
  - `take-action` (`expectsApproval`): **1 approval**, auto-approved consent
    card, server-side archive executed inside the recording before the beat
    is considered settled.
  - `save-app`: settles in **7.3s** (action-only beat, no generated view
    expected).
- **`panel-chrome-chips.png`** — the `/vendo` panel on load: demo chrome
  badge ("Template Sample demo · built with Vendo · sample data"), the "Get
  this in your product" CTA, and the suggestion-chip strip from
  `demo.config.json`'s beats. Proves Task 5 (demo chrome + chips) render
  together.
- **`consent-card.png`** — the `@vendoai/ui` approval card shown mid-thread
  for the `take-action` beat, before auto-approval. Proves the caps-guard-
  wrapped Vendo handler surfaces a real consent step for an action with
  side effects.
- **`limit-card.png`** — the friendly "this demo has reached its limit / book
  a call" card the caps guard renders on load once a demo's turn cap is
  exhausted. Proves Task 4 (caps guard) degrades to the CTA instead of a raw
  error.

## Regenerating

```sh
# Re-run the acceptance capture (writes to the gitignored output/ dir):
pnpm --filter @vendoai/bench demo:capture -- demo-beats \
  --host-config apps/demo-template --run-id <new-run-id>

# Re-encode a GIF under ~9 MB (adjust scale/fps/colors until it fits):
ffmpeg -i <input>.gif -vf "fps=8,scale=720:-1:flags=lanczos,palettegen=stats_mode=diff:max_colors=128" \
  -update 1 -frames:v 1 /tmp/palette.png
ffmpeg -i <input>.gif -i /tmp/palette.png \
  -filter_complex "fps=8,scale=720:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" \
  <output>.gif
```
