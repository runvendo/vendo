# genui-bench

The interactive inner loop for the micro-app format and generation pipeline:
type a prompt (or run a pack), watch four lanes answer it side by side — the
Vendo lane as a fully interactive app on the production `@vendoai/ui` renderer
with tool calls executing against canned host fixtures, and Thesys C1 /
CopilotKit / Tambo rendered with their own SDKs — with every run persisted as
a RunRecord you can reload, pin, and split-compare. Private workspace app,
never published or deployed. There is deliberately no judging: eyes are the
judge. Spec: `docs/superpowers/specs/2026-07-26-genui-bench-playground-design.md`.

## Quickstart

```bash
# cockpit (dev server, http://localhost:3000)
pnpm --filter genui-bench dev

# headless CLI — same runner, prints RunRecord paths + one JSON summary line
pnpm --filter genui-bench bench run --host maple --pack smoke --lanes vendo
pnpm --filter genui-bench bench run --host cadence --prompt "show unpaid invoices" --lanes vendo,copilotkit
```

CLI flags: `--host <maple|cadence>` (required), `--prompt "..."` (repeatable)
or `--pack <name>` (mutually exclusive), `--lanes` (comma list, default
`vendo`), `--runs-dir <dir>` (default `runs/`).

## Lane keys

Keys load from the repo-root `.env` (source-only; a missing key marks that
lane `{"status":"no-key"}` and the run proceeds):

| Lane       | Key                 | Notes                                                        |
| ---------- | ------------------- | ------------------------------------------------------------ |
| vendo      | `ANTHROPIC_API_KEY` | production engine + PipelineEvent tap                        |
| copilotkit | `ANTHROPIC_API_KEY` | self-hosted runtime (keyless — no CopilotKit account needed) |
| thesys-c1  | `THESYS_API_KEY`    | their API + their React renderer                             |
| tambo      | `TAMBO_API_KEY`     | their orchestration + harness component registry             |

`GENUI_BENCH_MODEL` overrides the Vendo/CopilotKit model id.
`GENUI_BENCH_FAKE_LANES=1` swaps every lane for a stub (tests, no keys).

Working in a git worktree (or keeping keys outside the repo)? There is no
`.env` at the worktree root, so source your key file into the shell first —
`set -a; source /path/to/.env; set +a` — before `bench run` or `dev`. The dev
server inherits the environment it was started with.

## Packs

Committed prompt sets under `packs/*.json` (versioned, shared with agents —
unlike `runs/`, which is gitignored):

```json
{ "name": "smoke", "prompts": ["show my account balances at a glance", "..."] }
```

The cockpit's Packs dropdown reads them and can append the current prompt to
a pack; the CLI runs one with `--pack <name>`.

## runs/ layout

Each run is a directory `runs/<id>/` (id = `yyyymmdd-hhmmss-hex4`):

- `run.json` — the slim RunRecord: prompt, host, git SHA + dirty-diff hash,
  per-lane `{status, duration, cost}`, pin label.
- `vendo.wire.txt`, `vendo.document.json`, `vendo.events.json` — Vendo wire
  text, final AppDocument, and the tapped PipelineEvent log.
- `<lane>.raw.json` — a competitor lane's raw request/response payload.

Pinning writes a label into `run.json`; pinned runs sort first in the rail.
Failed runs persist too (partial event logs included) — they are first-class
study objects.

## How agents use it

Edit engine/prompt/guardrail code → `pnpm --filter genui-bench bench run
--host maple --pack smoke --lanes vendo` → read the summary line
(per prompt: status, `durationMs`, `repairs`) → repeat. RunRecord paths are
PR evidence, and agent runs appear in the cockpit history rail automatically
(same `runs/` dir). For deeper study, read the per-lane artifacts inside the
printed run directory instead of re-running.
