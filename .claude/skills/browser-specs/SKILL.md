---
name: browser-specs
description: How to iterate on and prove a Playwright browser spec in this repo — the two-speed warm-harness loop for editing, the fresh production build that is the only result worth reporting, and the rule that an agent scripts a browser flow rather than stepping through it click-by-click. Use when writing, debugging, or verifying any browser/Playwright spec, or when a UI-affecting change needs real-browser proof.
---

# Browser specs

## Iterating is two-speed

While you are editing, start ONE warm hot-reloading harness (`VENDO_HARNESS_DEV=1`
plus a pinned `VENDO_HARNESS_PORT`) and rerun specs against it with the same two
variables — reuse is dev-mode-only, so every rerun skips the build and starts in
seconds.

Then one run WITHOUT the flag — a fresh production build — is the proof of
record, and the only result worth reporting. A production run never reuses a
server: `vite preview` serves whatever was built last, so a reused one greens the
previous build.

## Script the flow, don't step through it

An agent proves a browser flow by SCRIPTING it, never by stepping through it
click-by-click: write one throwaway Playwright script for the whole flow, run it
once, judge the screenshot/video artifacts — one model turn instead of fifteen,
seconds instead of minutes.

Interactive stepping is for two cases only: exploring UI the agent didn't write,
and diagnosing a scripted run that failed for unclear reasons — and whatever
stepping teaches gets banked as a script so the flow is never stepped twice.

## Where this runs

No browser runs in CI (2026-08-06) — headless mis-resolves `:focus-visible` and
`light-dark()`, so the Playwright suites stay a LOCAL pre-PR gate.
