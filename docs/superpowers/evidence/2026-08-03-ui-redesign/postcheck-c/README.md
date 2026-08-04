# Post-check round C — performance, and making the gate real

Branch `redesign/postcheck-c` (from `redesign/final-cleanup`). Four items from
the independent checker: H15, H16, checklist 11, checklist 12.

## H15 — one `/approvals` poller, measured

`useAttention` was per-instance, so every attention surface ran its own 5s
`GET /approvals`: the launcher badge (`chrome/launcher-status.tsx:67`, mounted
unconditionally by `VendoOverlay`), the waiting strip
(`chrome/waiting-queue.tsx:92`) and the center's needs-you rail
(`chrome/center/rail.tsx:141`).

`src/hooks/approvals-feed.ts` is now the single store per client (the same shape
as the run-activity store): N subscribers, one request, the cadence being the
fastest anybody asked for, paused while the document is hidden, stopped when the
last surface unmounts. **No consumer changed.**

Measured in a real browser on `/attention-surfaces` (the center page + the
overlay launcher = all three surfaces, nothing waiting but the fixture's one
ask), 60 seconds each, same machine, same scenario, only
`src/hooks/use-approvals.ts` swapped:

| | requests in 60s |
| --- | --- |
| `approvals-poller-trace-BEFORE.txt` (`redesign/final-cleanup`) | **39** — three per tick |
| `approvals-poller-trace-AFTER.txt` (this branch) | **13** — one per tick |

The BEFORE offsets show the triple: `292, 292, 292, 5272, 5272, 5273, …`.

Reproduce either side with:

```
VENDO_POLLER_PROOF=1 pnpm --filter @vendoai/ui test:browser \
  e2e/approvals-poller-proof.spec.ts
```

(opt-in, because it is a 60-second measurement). Unit coverage of the same
invariants — three mounts on one request, three surfaces costing what one costs,
zero pollers after the last unmount, paused while hidden, one decision clearing
every surface — is `packages/ui/test/approvals-feed.test.tsx`.

## H16 — an app tile nobody scrolled to boots nothing

The mechanism lives in the hooks layer: `useApp(appId, { enabled })` (defaults
on) plus a sticky `useInViewport`. `packages/ui/test/app-boot-gate.test.tsx`
proves zero requests while disabled, exactly two on enable, and the
no-IntersectionObserver fallback (which is what jsdom hits, so no other suite
changes behaviour).

**Handed to the round that owns `chrome/center/home.tsx`** — three lines in
`TilePreview` (the ONE place both the home shelf and the Apps page boot an app):

```tsx
import { useInViewport } from "../../hooks/use-in-viewport.js";
// …inside TilePreview:
const { ref, seen } = useInViewport<HTMLSpanElement>();
const { surface } = useApp(appId, { enabled: seen });
if (!surface) return <span ref={ref} className="fl-tile-skel" />;
return <span ref={ref} className="fl-tile-scale"><AppFrame surface={surface} components={components} /></span>;
```

`useInViewport` is deliberately NOT in the public hook surface: one internal
caller, no new API to support. `useApp`'s `enabled` is public and additive.

Until that lands, `chrome/center/apps-page.tsx:148-150` still boots every app in
the list.

## Checklist 11 — the smoke pack covers the wave

`smoke-pack.log` — 11 tests, 15.6s, one skipped (below).
`consumer-voice-ci-specs.log` — the four consumer-voice specs now wired into the
CI browser job, 6.4s.

| smoke case | surface | law |
| --- | --- | --- |
| landing greeting · suggestions · composer | thread landing | — |
| a scripted turn streams text | thread | — |
| the approval card decides | consent card | humanized, never a slug |
| the overlay opens and closes on Escape | overlay | — |
| beats → the settled "Did 3 things" row | transcript | §1 |
| a build animates EXACTLY one element | build card | §8 A2 + D1 |
| the pill works while closed, then offers the result | launcher | §2/§3 |
| the waiting strip counts and clears | strip | §4 N1 |
| the center's two doors + needs-you clearing | rail | §10, §4 |
| a failed build ends in ✕ + prose, nothing to poke | thread | §15, §16 law 3 |
| a stream-killed turn offers no Retry | thread banner | §15 / ruling 16 — **quarantined** |

Two skips, both real defects and neither mine to fix:

- **ruling 16** — `chrome/thread/index.tsx:284-306` still renders a `Retry`
  button on a broken turn. Proven live: `[stream-kill]` yields
  `["Copy","Copy","Copy","Edit","Copy","Regenerate","Retry",…]`. The assertion
  is written and quarantined; deleting the `test.fixme` belongs to that round's
  commit.
- **wave3 `the share picker … offers a person`** — quarantined before this round
  (the wire fixture never sets `status().namesPeople`). Left exactly as it was.

`build-failed-banner.spec.ts` was RED on `redesign/final-cleanup` and in no CI
job: it still demanded the wire's own sentence ("app build failed: generation
failed") on screen after §16 law 3 replaced it with `BUILD_FAILURE_COPY`. The
assertion is now the other way round.

Heads-up for whoever runs these locally: `pass3-consumer-voice`,
`run-history-voice` and `wave3-consumer-voice` rewrite the PNGs under
`pass3/` and `final-cleanup/`, which belong to those lanes (ruling 13d). Restore
them rather than committing the new bytes.

## Checklist 12 — the gate log

`../gates/` — the forced four-gate run, with the command lines and the
`Cached: 0 cached` lines. See `../gates/README.md`.
