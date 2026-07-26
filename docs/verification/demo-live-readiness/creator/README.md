# demo-creator live-readiness evidence (criteria 32–37)

## THE CANONICAL RUN — one clean uninterrupted `demo:pipeline` invocation (criterion 34)

`timings-clean-run.json` + `clean-run/` — prospect https://linear.app, id `linear-tracker`,
2026-07-27, ONE command, zero interruptions: **36.9 minutes end-to-end wall-clock**
(14:14:36 → 14:51:31), inside both the 45-minute p50 target and the 2-hour cap.
One honest row per stage occurrence: create/install/research (15s), plan (33s),
5 parallel rewrite agents (8.9 min), assembly incl. one repair round (7.4 min),
judge round 1 FAIL(logo 6) → targeted fix → round 2 PASS (9/7/8/8/8, 8.4 min
total), beats capture (4.9 min), deploy (38s, first attempt), final gate incl.
the Railway build wait (6.0 min) — real login through the injected wall,
3 scenario cards, one live generation to a settled turn, 6/6 PASS
(`clean-run/GATE.md`, `clean-run/FIDELITY.md`, screenshots). The linear-tracker
deployment was reaped after the proof (it duplicated the standing linear-issues
demo); the committed artifacts are its record.

## The standing demo — linear-issues (criteria 32–37 development run)

Live demo: https://demos.vendo.run/linear-issues · demo password `linear-issues-demo` (seeded fallback; `DEMO_PASSWORD` env overrides) · expires 2026-08-16.
Produced by `demo:pipeline` on 2026-07-26/27 from https://linear.app + two operator screenshots hand-captured from Linear's public site/docs (stand-ins for customer-provided images; provenance in the app's RESEARCH/manifest.json).

## Artifacts

- `GATE.md` + `gate-1…5*.png` — the final self-gate on the DEPLOYED demo: real login through the injected wall, all 3 scenario cards, one live generation to a settled turn (criterion 37). 6/6 PASS.
- `FIDELITY.md` — judge verdict (criteria 35/36): PASS with logo 8, palette 7, type 7, layout 7, copyTone 8, scored against BOTH operator screenshots and the live-site capture. An earlier run of the same pipeline proved the fix loop live (logo 4→8, copyTone 6→9 after targeted per-dimension fix agents).
- `demo-beats-linear-issues.gif` — the demo-beats capture: all 3 beats delivered with their declared `expectsView`/`expectsApproval` verified (criterion 34 deliverable).
- `judge-rounds/` — the built-screen captures the judge scored.
- `timings.json` — the raw per-occurrence stage table (criterion 34's timing table). Read it with the notes below.

## Appendix: reading timings.json (the linear-issues development-run table)

This was the tooling's FIRST live run, and the run was interrupted four times by
tooling defects found and fixed mid-flight (each fix is a lane commit). Every
interrupted stage occurrence stays in the table — rows are one-per-occurrence
(`#n` suffixes from the recorder; earlier occurrences predate the suffix fix
and are ordered by `startedAt`).

- **Shipped-path stage time (the work that produced the live demo): ~44 min**
  — validate/create/install/research (29s), plan (40s), parallel rewrite agents
  (13.4 min), assembly incl. one repair round (6.1 min), judge PASS round
  (4.5 min), beats capture (5.6 min), deploys (the successful upload cycles,
  ~11 min total) and the final gate (1.7 min). Add the Railway Docker build
  (~10–15 min, visible as `await-auth-build` plus wait time inside gate rows)
  for ~55–60 min end-to-end on a clean run.
- **All occurrences including failures/retries: ~79 min** of measured stage time.
- **Calendar span of the table (~9.9 h)** covers the between-segment tooling
  fixes and is NOT pipeline execution time.
- **Dominant stages:** the parallel rewrite (13.4 min — down from the old
  40–60 min serial pass), the Railway monorepo Docker build (~10–15 min), and
  `railway up` uploads, which failed with a `BadRecordMac` TLS error on ~80% of
  attempts from this machine that night — **the successful deploys took up to 8
  retries**; the retry loop is part of the pipeline.
- Versus the 45-minute p50 target: this first run exceeded it; the pipeline
  now enforces the contract's 2-hour wall-clock cap internally (parks with
  named gaps, never deploys past it). The levers to reach 45 min are the
  rewrite prompts, a warmed build cache, and Railway layer caching.
