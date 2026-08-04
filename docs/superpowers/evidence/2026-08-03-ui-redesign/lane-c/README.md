# Lane C — the transcript shows the work: real-browser proof (2026-08-03)

Captured headless (Playwright + Chromium) against the SHIPPED chrome —
`VendoThread` from `packages/ui/src` with the Maple theme — driven by the
shipped **director mode** (`ScriptedTransport`, `packages/ui/src/hooks/
scripted-transport.ts`). Only the SOURCE of the part stream is scripted: the
transcript, beats, summary row, fold/reopen, and turn choreography are the real
components rendering a real `UIMessageChunk` stream. Director mode is how a
FAILING turn becomes deterministic — and app generation is broken on this
branch, so a live build was not an option.

## 1. `beats.gif` — a live multi-tool turn

Three host calls stream in; each leaves a beat where it happened, ticks with
its short humanized result, and the settled turn folds into one row.

- `beats-01-working.png` — "● List transactions…" (static orb, the "…" carries
  the working state — Lane A's build calm).
- `beats-02-ticking.png` — "✓ List transactions · 142 transactions" /
  "✓ List categories · 9 categories". The result is a COUNT named by the
  output's own key; nothing is invented, and no raw slug appears. The quiet
  `Working…` ribbon holds the between-steps gap (the one ribbon role that
  survives).
- `beats-03-folded.png` — settled: "✓ Did 3 things · 6.6s", standing exactly
  where the first beat stood, between the two prose lines.
- `beats-04-reopened.png` — one click reopens the checklist under the row
  (`aria-expanded` flips; the control does not move).

## 2. `failure.gif` — a fault-injected failing turn (spec §15)

The first call fails, the agent's own prose carries the recovery, and the retry
is just more beats. There is no failure UI.

- `failure-01-error-beat.png` — "✕ List transactions — couldn't finish".
- `failure-02-prose-continues.png` — "That pull timed out and nothing was
  changed. Let me take July in two halves." — a text part, like any other line.
- `failure-03-settled.png` — the ✕ beat **stays** after the fold, and the row
  reads "Did 2 things" — the failed call is not counted as a thing that
  happened. The provider's `errorText` ("upstream timeout after 30s (request
  8f21c)") is never shown to a person.

The §15 audit, read off the live DOM at that moment:

```
{"errorBeats":1,"furniture":[],
 "buttons":["Copy","Edit","Did 2 things · 8.3s","Copy","Regenerate","Send"],
 "summary":"Did 2 things · 8.3s"}
```

`furniture` scans the turn for `.fl-chip`, `.fl-cardshell`, `.fl-approval`,
`.fl-buildfail`, `.fl-btn-primary`, `.fl-btn-ceremony`, `.fl-connect`,
`.fl-waiting` — all absent. The only buttons on the surface are the shipped
turn actions (Copy · Edit · Regenerate), the summary disclosure, and Send:
retry is the composer and Regenerate, exactly as the spec says. The same
invariant is pinned as a test in
`packages/ui/test/chrome/transcript-beats.test.tsx`.
