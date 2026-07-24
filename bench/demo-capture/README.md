# Demo capture

This is the repeatable capture tool for the UI-generation demo beats:
streaming first paint, host-component composition, remix/edit continuity, the
five-repo corpus montage, and the generic `demo-beats` capture for
template-derived demo apps. The driver lives in `bench/src/demo-capture/` so
it participates in the existing `@vendoai/bench` build, tests, and typecheck.
Artifacts land in `bench/demo-capture/output/<run-id>/`, which is gitignored.

## Prerequisites

- Run from the repo root after `pnpm install` and `pnpm build`.
- Install Chromium once if Playwright has not already done so:
  `pnpm --filter @vendoai/bench exec playwright install chromium`.
- Install `ffmpeg` and `ffprobe` on `PATH`.
- For live demo beats, source the shared keys into the current shell. Never
  print them or commit an env file:

```sh
set -a
source /Users/yousefh/orca/workspaces/flowlet/.env
set +a
```

Both demos require `ANTHROPIC_API_KEY`. This is equivalent to each app's
documented `.env.local` pattern, but the capture tool intentionally writes
nothing under `apps/`. Maple is `demo-bank` at `/vendo`; Cadence is
`demo-accounting` at `/assistant`.

Both demos sit behind a real login wall (ENG-260). The capture signs in by
itself with the primary seeded demo user (the login form prefills the email)
and the shared demo password: `MAPLE_DEMO_PASSWORD` / `CADENCE_DEMO_PASSWORD`
when set, otherwise each demo's seeded dev fallback (`maple-demo` /
`cadence-demo`). No flags are needed for a local capture.

## The four one-command beats

Use a distinct `--run-id` for each measurement wave so its raw recording and
measurement metadata stay together.

```sh
# 1. Final beat is one side-by-side GIF; host-specific GIFs are retained too.
pnpm --filter @vendoai/bench demo:capture -- \
  streaming-first-paint --host both --run-id after-streaming

# 2. Runnable now; becomes a real catalog proof after ENG-241 lands.
pnpm --filter @vendoai/bench demo:capture -- \
  host-component --host maple --run-id after-catalog

# 3. Records generation and edit continuously, with iframe continuity status.
pnpm --filter @vendoai/bench demo:capture -- \
  remix-edit --host maple --run-id after-remix

# 4. Consumes the Wave-1 run contract and makes the five-repo montage.
pnpm --filter @vendoai/bench demo:capture -- corpus-montage \
  --gallery-run corpus/.repos/.gallery/<runId> \
  --output bench/demo-capture/output/<runId>/corpus-montage.gif
```

The first command boots Maple and Cadence sequentially on port 3000. It takes
`/tmp/vendo-l3-port3000.lock` before binding and waits when another Layer-3 run
owns the port. The lock and server are released on success or failure. To use
an already running host, pass `--no-boot --host maple --url
http://127.0.0.1:3000`; `--port` selects a different boot port.

The stopwatch is installed in the page, starts from the real message-composer
submit event, and remains visible in the recording. It marks the first visible
`data-vendo-node-id` as first paint and the first idle, enabled-composer state
as usable, beside the `<1s paint / <10s usable` bars. The remix beat adds an
iframe visibility probe and accumulated blank-sample count before the edit is
submitted.

## Parameters and outputs

All live beats accept `--host maple|cadence|both`, `--prompt`, `--port`,
`--timeout-ms`, `--headed`, `--output-dir`, and `--run-id`. Remix also accepts
`--edit-prompt`. Run `pnpm --filter @vendoai/bench demo:capture -- --help` for
the compact CLI reference.

Each host directory contains the raw Playwright video, `server.log`, and
`capture.json` with the prompts and measured overlay marks. The run root holds
the converted GIFs. With `--host both`, the beat-named GIF is the combined
artifact while `*-maple.gif` and `*-cadence.gif` remain available for review.

## Generic template-derived demos (`--host-config`)

`demo-beats` is the acceptance check for a generated per-prospect demo (the
full creator flow — `demo:create` → `demo:research` → rewrite → this capture →
`demo:deploy` — is contracted in the `demo-creator` skill's PLAYBOOK.md,
in the vendo-skills repo at `~/.claude/skills/demo-creator/`). A
passing run proves exactly this contract: the app boots from its own
directory, every configured beat's prompt submits and settles without a
surfaced error, each beat's DECLARED expectations are met (`expectsView` — a
generated-UI first paint was marked; `expectsApproval` — a consent card
appeared and was auto-approved), and the stopwatch marks land in
`capture.json` with the GIF. Beats without declared expectations are only
verified to settle cleanly — declare expectations in demo.config.json for
anything the demo story depends on.

```sh
pnpm --filter @vendoai/bench demo:capture -- demo-beats \
  --host-config apps/demo-template --run-id my-demo --port 3100
```

`--host-config` takes the app directory of a template-derived demo
(`apps/demo-template` or a per-prospect clone) instead of `--host` — the two
are mutually exclusive, and there is no `both`. A relative path is anchored at
the repo root. Everything else is derived from the directory by the template's
conventions, so there are no route/thread flags:

- The app must contain `demo.config.json` (validated with the app's own
  schema, `apps/demo-template/src/lib/demo-config.ts`, imported by bench via
  the `demo-template/demo-config` package export) and a `package.json` whose
  `name` is used to boot it through `pnpm --filter <name> dev`.
- The panel route is always `/vendo` — fenced template plumbing that clones
  keep.
- The reset thread id derives from the demo id the way the concrete hosts pin
  theirs: `"acme-widgets"` → `thr_acme_widgets_demo`.
- No login wall: the sign-in helper no-ops when no `/login` form is present.

The config's `beats[]` run sequentially in ONE continuous recording — the
thread is never reset between beats, so the GIF tells one demo story. Each
beat reinstalls the stopwatch overlay under its own `BEAT n/m · <key>` label
(disposing the previous overlay's ticker): the timer starts from that beat's
real composer submit, and first paint only counts generated nodes that
appeared after the beat started (earlier beats' views stay on screen). Any
consent card that parks a run is auto-approved (the `Approve` button of
`@vendoai/ui`'s ApprovalCard) and counted per beat; after an approval, the
beat is not considered settled until the resumed run has visibly gone busy
and returned idle with no approval still pending, so the approved tool's
execution is inside the recording. A beat completes on a settled new
assistant turn — an action beat may legitimately finish without generating a
view, which is why unmet `expectsView`/`expectsApproval` declarations (not
guesses) are what fail the run.

Outputs match the concrete hosts: `<run>/<demo-id>/server.log`, raw video,
`capture.json` with per-beat marks, and `demo-beats-<demo-id>.gif` at the run
root. Booting runs the app's own `pnpm dev` (which resyncs `.vendo/`). A
capture consumes several of the demo's own capped turns, so it deletes
`<app>/.vendo/data/demo-caps.json` at start for a fresh local run (deployed
demos are untouched — that file only exists where the app process runs); if
caps are still exhausted mid-run, the capture fails with a distinct
"demo caps exhausted" error rather than a generic one. Note the runtime
import of the app's TypeScript schema relies on Node's type stripping
(Node 23.6+, as shipped with this repo's toolchain); the other beats keep
working on Node >= 20.

The montage discovers one immediate directory per repo, recursively selects a
host/native screenshot plus a generated GIF/video, and reads `timings.json`
without assuming a prompt subdirectory name. Each repo becomes a vertical
host-over-generated column; up to five columns are stacked side by side. When
the installed ffmpeg includes `drawtext`, repo names and first-paint/usable
timings are burned into the GIF. Minimal ffmpeg builds without that filter
produce the same ordered visual grid without labels.
