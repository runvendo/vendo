# Defect D2 verification — byo-ai-sdk host (vercel/ai-chatbot), port 3001

Host state: `pnpm install --force`, published `@vendoai/vendo@0.4.6` +
`vendoai@0.4.6`, fresh `.next` before every run.

## 1. Pristine 0.4.6 baseline (reconciliation)

One trivial create_app turn ("one stat tile that says hello"):

- Server persisted the #532 terminal record ~10s post-send
  (`[vendo] app build failed (app_ea7e33f3-…): nothing in this request could
  be built with this host's tools — …`).
- OWNER poll: `open?pending=1` answered `{"kind":"failed","reason":…}` on the
  first post-failure poll; the embed left the skeleton at **31.4s**
  (`pristine-046-owner-embed-resolved-31s.png`). `data-state` flips
  building→ready; note the aria-hidden "Building …" label span stays in the
  DOM for the crossfade — text-content probes must key on `data-state` or the
  failure beat, not on the string "Building".
- S2 probe (fresh guest session, same appId): `{"kind":"pending"}` — the
  masking the 0.4.6 cert's live wire check hit. Root cause: the wire's
  existence probe used `appStore()` → raw SQL over a local db handle, which a
  hosted (Vendo Cloud) wire-door store doesn't have, so it answered `false`
  on every call and every owner-scoped not-found masked to pending.

## 2. Deadline at its bound, pristine 0.4.6

`defectd2-deadline-demo.mjs`: every `open?pending=1` request intercepted
browser-side and left hanging (20 polls held, zero settled).

- The per-poll 15s timeout kept the loop re-arming (~16.2s cadence).
- The absolute deadline flipped the beat to the failed vocabulary
  **301s after embed mount** (bound: APP_BUILD_DEADLINE_MS = 300s) —
  `deadline-fired-301s-pristine-046.png`, reason "the build never finished".

## 3. Fixed wire (this PR's dist hand-copied over 0.4.6)

Same failed appId, fresh guest session (S2):

    before: {"kind":"pending"}
    after:  {"kind":"failed","reason":"nothing in this request could be built
             with this host's tools — …","retryable":false}

Unknown appId still answers `{"kind":"pending"}` (the true build window).
