# Lane D evidence — background attention (spec §2 G1, §3 H1, §4 N1)

Captured 2026-08-03 in headless Chromium (Playwright) against the real
`@vendoai/ui` chrome on a Maple-themed host page. The conversation runs on the
shipped `ScriptedTransport` (director mode) so a multi-step turn is
deterministic and paced for video — generation is broken on this branch, and a
scripted stream drives the SAME components a live model would. Approvals come
from the package's own wire fixture (`packages/ui/test/wire-server.ts`).

## life.gif — one whole life of a run that outlives the panel

1. Ask ("How did my July spending go?") — the panel narrates as usual.
2. **Close the panel mid-run.** The run does not stop.
3. The launcher pill takes over: humanized beat label (host `ToolMeta`, the
   ENG-216 pipeline) + a quiet indeterminate ring, becoming a determinate ring
   once the turn has begun more than one step.
4. It finishes: one toast, a result headline and `View`. Nothing opens itself.
5. `View` reopens the PANEL to that conversation — the finished turn is sitting
   where it was left (the thread is the record).

Stills: `01-idle-pill` · `02-running-in-panel` ·
`03-pill-narrates-indeterminate` · `04-pill-ring-determinate` ·
`05-completion-toast` · `06-view-reopens-record`.

## signals.gif — the two distinct signals

1. An ask is waiting → the pill carries a **numbered badge** (a count, not a
   dot); the "Waiting on you · N" strip counts the same source (`useAttention`).
2. Approving it clears both at once.
3. A run finishes while the panel is closed → toast; ignored, it withdraws
   after ~6s and leaves a **quiet dot** (unseen results).
4. Opening the panel clears the dot. Nothing auto-opened or auto-folded at any
   point.

Stills: `10-badge-count` · `11-badge-cleared` · `12-unseen-dot` ·
`13-dot-cleared-on-open` · `14-settled-no-signals`.

## Reproducing

`capture.mjs`, `main.tsx`, `vite.config.ts`, `index.html` are the throwaway
capture rig, copied here verbatim. To re-run from a worktree:

```sh
mkdir -p packages/ui/.lane-d-capture && cp docs/superpowers/evidence/2026-08-03-ui-redesign/lane-d/{capture.mjs,main.tsx,vite.config.ts,index.html} packages/ui/.lane-d-capture/
cd packages/ui && pnpm exec vite --config .lane-d-capture/vite.config.ts --host 127.0.0.1 --port 4274 &
node .lane-d-capture/capture.mjs   # writes /tmp/lane-d-capture
```

The unit proof is `packages/ui/test/chrome/pill-states.test.tsx` (12 tests:
every pill state, the never-auto-open law, the toast deep-link, and a real
close-mid-run turn over the wire fixture).
