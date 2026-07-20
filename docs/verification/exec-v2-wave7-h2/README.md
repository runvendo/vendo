# execution-v2 Wave 7 H2 — product hardening evidence

Live and browser evidence for the four Wave 7 H2 items (fn-binding envelope
paths, iframe keepalive, warm box template, Procfile flake).

## Item 3 — box build speed (live e2b + real Claude)

`measure-box-build.mjs` boots a box from a built template, runs one layer-3
kanban box edit ("full web app, drag-and-drop invoice kanban") against
`claude-sonnet-4-5`, and profiles the ISO-stamped agent log (harness.mjs now
timestamps task-log lines). Full logs beside this file (`agent-log-*.txt`).

| run | template | build | notes |
| --- | --- | --- | --- |
| baseline | harness only (pre-scaffold) | 195.2s | 14.5KB server.js written by the model, then FULLY REWRITTEN once to fix a template-literal bug (~97s of codegen on plumbing) |
| baseline2 | harness only | 153.9s | lucky run: no plumbing rewrite this time |
| warm1 | + scaffold | 136.4s | agent copied the scaffold, wrote only fns.js + index.html; no plumbing rewrite |
| warm2 | + scaffold, tightened cp prompt | 179.7s | scaffold ridden, but 24 verification turns (one curl per turn) + feature creep gave time back |
| warm3 | + scaffold + batched-verification prompt (shipped config) | 133.5s | 13 turns; verification batched |
| warm4 | shipped config | 174.5s | scaffold ridden (2 writes only); slow-model run, extra verification |

Baseline mean 174.6s, shipped-config mean 154.0s: an honest ~12% mean cut on
n=2 with high run-to-run variance, best-case 133.5s vs the 195.2s
rewrite-hit baseline (32%). Below the >40% example target, and here is why,
measured: zero `npm install` anywhere (the zero-dependency doctrine holds,
so there is no node_modules to pre-bake — the "+ node_modules" half of the
item is empty by construction), boot is ~2s, and the whole build is model
round trips. The scaffold removes the one structural failure-and-cost class
it can (writing ~14.5KB of skin-contract plumbing and occasionally fully
rewriting it on a syntax bug — the baseline run above paid ~97s for that;
every warm run wrote exactly 2 app files and never touched plumbing). What
remains is generating the app-specific UI (~40s of tokens for a ~9KB page)
plus the agent's self-verification turns — model-latency-bound, and cutting
verification depth would trade away the design's self-verification floor.
The next real lever is a faster inference model in the box
(`VENDO_INFERENCE_MODEL`), which is a behavior decision, not template
warming, so it is left for Yousef.

All sandboxes destroyed at the end of every run (the script kills its box in
a `finally`; account swept after the campaign).

## Item 2 — iframe keepalive (real browser)

`embed-harness/` mounts the REAL `@vendoai/ui` `AppFrame` (esbuild bundle of
the built package) around the REAL scaffold server from item 3, with the
keepalive seam scripted so the machine-sleep transition is deterministic:

- `browser/w7h2-01-embedded-awake-ping.png` — the served kanban embedded;
  user activity produced `POST /apps/:id/machine/ping → { state: "awake" }`
  (the idle-timer ride).
- `browser/w7h2-02-woke-resuming-cover.png` — after the machine "slept", the
  next activity ping answered `woke`: the frame swapped to the EXISTING
  resuming cover while the re-open ran (no dead iframe under the user).
- `browser/w7h2-03-reloaded-fresh-url.png` — the re-open landed the fresh
  machine URL (`?wake=2`, page shows "machine wake #2") and the board is back.

Machine-side semantics (wake sharing, HEAD-through-the-idle-tracked-wrapper,
owner scoping) are covered by `packages/apps/src/served-apps.test.ts` and
`packages/vendo/src/served-apps-wire.test.ts`; the AppFrame loop by
`packages/ui/test/tree/frames-and-jail.test.tsx`.

Rebuild the harness bundle with:

```
node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/bin/esbuild \
  docs/verification/exec-v2-wave7-h2/embed-harness/entry.jsx --bundle \
  --outfile=docs/verification/exec-v2-wave7-h2/embed-harness/bundle.js \
  --jsx=automatic --format=iife --define:process.env.NODE_ENV='"production"' \
  --alias:react=./packages/ui/node_modules/react \
  --alias:react-dom=./packages/ui/node_modules/react-dom
```

then serve `embed-harness/` statically and the scaffold
(`packages/apps/box/scaffold`, `PORT=8123 node server.js`) beside it.
