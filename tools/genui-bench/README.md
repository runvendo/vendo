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
`vendo`), `--runs-dir <dir>` (default `runs/`), plus the model controls below.

## Model controls

Model choice is a per-run input, not an env var — history stamps it, so
split-compare doubles as a model A/B. It applies to the **Vendo lane only**
(the engine under study); competitor lanes keep their own model defaults.

**No model chosen = the engine's production default**, so an untouched run
measures what ships. The single source of truth is `runner/models.ts`.

| Model      | Id                           | Temperature | Thinking       |
| ---------- | ---------------------------- | ----------- | -------------- |
| Fable 5    | `claude-fable-5`             | —           | effort         |
| Opus 5     | `claude-opus-5`              | —           | effort         |
| Sonnet 5   | `claude-sonnet-5`            | —           | effort         |
| Sonnet 4.6 | `claude-sonnet-4-6` **(engine default)** | 0–1 | token budget |
| Haiku 4.5  | `claude-haiku-4-5-20251001`  | 0–1         | token budget   |

The two dialects are the API's, not ours: the Claude 5 line **removed**
`temperature` and thinking token budgets (both 400) and replaced depth with
`output_config.effort`; Haiku 4.5 has no `effort` parameter. A setting the
chosen model rejects is a hard error at the CLI/cockpit/adapter — never a
silent drop, which would make an A/B lie about what it measured.

```bash
# same prompt on two models — the A/B
pnpm --filter genui-bench bench run --host maple --prompt "spending by category" --model "Opus 5" --thinking high
pnpm --filter genui-bench bench run --host maple --prompt "spending by category" --model "Haiku 4.5" --temperature 0.7
```

- `--model <id|label>` — any id or label from the table (`claude-opus-5`,
  `"Opus 5"`, `opus-5` all resolve).
- `--temperature <0-1>` — models with a temperature column only.
- `--thinking <tokens|low|medium|high>` — one flag, both dialects: a token
  budget (≥1024) for budget models, an effort level for the Claude 5 line.
- Sampling flags require an explicit `--model` (they are per-model settings).

The JSON summary line names the model that actually ran, default included:
`{"runs":[{"prompt":"…","model":{"id":"claude-opus-5","effort":"high"},"vendo":{…}}]}`.

In the cockpit, the prompt row's model chip (collapsed by default, last choice
remembered in `localStorage`) expands to the model list plus the settings that
model accepts; every history-rail entry shows the model its run used.

`GENUI_BENCH_MODEL` still works as the headless override for the default
path — it sets the id used when a run carries no model choice.

## Lane keys

Keys load from the repo-root `.env` (source-only; a missing key marks that
lane `{"status":"no-key"}` and the run proceeds):

| Lane       | Key                 | Notes                                                        |
| ---------- | ------------------- | ------------------------------------------------------------ |
| vendo      | `ANTHROPIC_API_KEY` | production conductor + checking-layer findings                |
| copilotkit | `ANTHROPIC_API_KEY` | self-hosted runtime (keyless — no CopilotKit account needed) |
| thesys-c1  | `THESYS_API_KEY`    | their API + their React renderer (model below)               |
| tambo      | `TAMBO_API_KEY`     | their orchestration + harness component registry             |

`GENUI_BENCH_MODEL` overrides the Vendo/CopilotKit default model id (a per-run
`--model` wins over it — see Model controls).
`GENUI_BENCH_FAKE_LANES=1` swaps every lane for a stub (tests, no keys).

**Thesys C1 is model-agnostic.** Their catalog (`GET /v1/embed/models`, 34
entries on 2026-07-26) carries OpenAI GPT-5/5.2 and Google Gemini 3 next to
Anthropic. The lane pins **`c1/anthropic/claude-sonnet-4.6/v-20260331`** —
their current best Anthropic model — so the comparison holds the model family
roughly constant with the Vendo lane; `THESYS_C1_MODEL` swaps it for a one-off
cross-provider look. The Thesys pane footnote always names the model that
produced what you are looking at. Their API returns the generated UI as the
final assistant content string wrapped in a `<content thesys="true"
version="2">` envelope around an ```openui-lang``` program; the lane passes
that string through untouched because `C1Component` parses the envelope
itself.

Working in a git worktree (or keeping keys outside the repo)? There is no
`.env` at the worktree root, so source your key file into the shell first —
`set -a; source /path/to/.env; set +a` — before `bench run` or `dev`. The dev
server inherits the environment it was started with.

## How the Vendo pane renders

The pane is an iframe onto this app's own `/embed/<host>?run=<id>` route. That
route boots the production runtime (`VendoProvider` with the host's real
`.vendo/theme.json` → `AppFrame` → Kit + the host's component registry) inside
a document whose only stylesheet is the demo host's own `globals.css`, so a
generated app gets the exact CSS context `examples/demo-bank` gives it — brand
tokens, Tailwind preflight, host utilities — and none of it can reach the
cockpit's hand-rolled dark chrome. Maple and Cadence define the same token
names with different values, which is why each host gets its own document
rather than a shared scoped layer. `/embed/maple?run=<id>` also opens directly
in a tab, full size, if you want to poke at one app on its own.

The frame is same-origin, so tool calls still POST straight to `/api/tools`
(no cross-frame plumbing) and split-compare is just two frames in
`&mode=readonly`.

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
- `vendo.wire.txt`, `vendo.document.json`, `vendo.findings.json` — Vendo wire
  text, final AppDocument, and what the checking layer still found on it.
- `<lane>.raw.json` — a competitor lane's raw request/response payload.

Pinning writes a label into `run.json`; pinned runs sort first in the rail.
Failed runs persist too — a refusal and a generation failure both carry their
sentences on the lane error, and they are first-class study objects.

## How agents use it

Edit engine/prompt/guardrail code → `pnpm --filter genui-bench bench run
--host maple --pack smoke --lanes vendo` → read the summary line
(per prompt: status, `durationMs`, `findings`) → repeat. RunRecord paths are
PR evidence, and agent runs appear in the cockpit history rail automatically
(same `runs/` dir). For deeper study, read the per-lane artifacts inside the
printed run directory instead of re-running.
