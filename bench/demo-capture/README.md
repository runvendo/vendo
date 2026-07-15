# Demo capture

This is the repeatable capture tool for the four UI-generation demo beats:
streaming first paint, host-component composition, remix/edit continuity, and
the five-repo corpus montage. The driver lives in `bench/src/demo-capture/` so
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

The montage discovers one immediate directory per repo, recursively selects a
host/native screenshot plus a generated GIF/video, and reads `timings.json`
without assuming a prompt subdirectory name. Each repo becomes a vertical
host-over-generated column; up to five columns are stacked side by side. When
the installed ffmpeg includes `drawtext`, repo names and first-paint/usable
timings are burned into the GIF. Minimal ffmpeg builds without that filter
produce the same ordered visual grid without labels.
