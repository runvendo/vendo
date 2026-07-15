# ENG-290 M3 — invisible graduation on real E2B

Captured 2026-07-15 with headless Chromium against the REAL public runtime
(`createApps` → `edit`/`call`/`open`) on real E2B machines. The model is
scripted so the climb is deterministic — the venue behavior is what this
verifies, not generation.

One app climbs rung 1 → 2 → 3 → 4. `invisible-graduation.mjs` proves:

- the app surface is **pixel-identical** across rungs 1–3 (buffer-equal
  element screenshots), while the status bar shows the rung, the opaque
  `e2b:v1:` server snapshot ref, and a live `fn:total(2,3) = 5` answered by
  the app's own server code on a machine resumed from that snapshot;
- rung 4 flips the surface to the app's real E2B machine URL, which serves
  the identical kept tree through the served-app scaffold
  (`[data-vendo-node-id]` DOM assertions against the cross-origin frame);
- every climb lands on the expected rung and a failed edit aborts the run.

Evidence: `rung-1..4.png` (full page), `surface-rung-1..4.png` (surface
crops used for the pixel-equality assertions), `invisible-graduation.gif`
(the four beats).

The surface renders through the served-app tree renderer — the same
`PayloadView` pipeline `AppFrame`'s tree path uses, and byte-for-byte the
bytes a graduated machine serves (`servedAppScaffold`), so rungs 1–3 and the
rung-4 machine paint the same UI by construction, and the assertions verify
it anyway.

## Run it

From the repository root after `pnpm install && pnpm build`, with `ffmpeg`
on PATH. Source the shared keys without printing them:

```sh
set -a
source /Users/yousefh/orca/workspaces/flowlet/.env
set +a
node docs/verification/eng-290-m3/invisible-graduation.mjs
```

The script exits nonzero on any rung, ref, fn, or pixel mismatch, deletes
the app (stopping its machines) on the way out, and overwrites the evidence
files on success.
