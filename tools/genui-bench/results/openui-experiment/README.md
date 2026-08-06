# openui-lang candidate-backend experiment — raw results

Real bench output from 2026-08-06, produced by the `openui` lane PR. Every
number and screenshot here comes from these RunRecords (`runs/<id>/`, copied
verbatim from the bench's gitignored `runs/` dir); `summary.json` is computed
from them, nothing hand-entered.

## What ran

- **Model (both lanes): `gemini-2.5-flash`** via the bench's keyless-Anthropic
  fallback (`runner/models.ts defaultModelId`) — no `ANTHROPIC_API_KEY`
  existed in this environment, so the run rode the root `.env`'s Gemini key.
  Same model in both lanes keeps the lane comparison fair, **but the Vendo
  engine ships tuned for `claude-sonnet-4-6`; its numbers here are NOT
  representative of the shipped engine on its shipped model.**
- Hosts: maple (bank fixture) and cadence (accounting fixture); packs:
  `smoke` on both hosts (as specified for the experiment), plus the
  bench's own `cadence` pack (the intended per-host pairing) and one warmup
  single prompt.
- Command per sweep, from the repo root with keys in the root `.env`:
  `pnpm --filter genui-bench bench run --host <maple|cadence> --pack <smoke|cadence> --lanes vendo,openui`

## What "ok" means per lane (they are NOT the same claim)

- **vendo ok** — the conductor shipped a checked AppDocument; `findings` is
  what the checking layer still reported on it. A refusal ("the host has no
  way to …") or invalid generation is `failed`.
- **openui ok** — their parser accepted the single-shot program and the
  Renderer can draw it. **It does not claim data grounding**: a program with
  zero `Query()` bindings that invents plausible numbers still parses clean
  and counts as ok with 0 findings. The lane's findings only catch bindings
  to tools the host does not expose (none occurred in these 15 runs).

## Headline numbers (15 runs)

| | vendo | openui |
| --- | --- | --- |
| ok | 2/15 | 15/15 |
| failed (incl. explicit refusals) | 13/15 (10 were conductor refusals with reasons) | 0/15 |
| ok runs with ≥1 real tool binding | 2/2 | **10/15** |
| ok runs with ZERO tool bindings (fabricated data) | 0 | **5/15** |
| hallucinated tool names | n/a | 0 |
| median ok duration | ~20s (2 runs: 12.7s, 27.4s) | 6.5s |

The 5 zero-binding openui runs are the off-surface asks (bank prompts on the
accounting host, and cadence-pack asks beyond the fixture's tools): the vendo
conductor refused those with a written reason; openui rendered confident
fabricated data (e.g. `$1,234.56` checking balances at an accounting firm —
see `screenshots/cadence-smoke-balances--101707.png`).

## Per-run table

Generated from the RunRecords; `s` = seconds, `f` = findings on an ok run.

| host | pack | prompt | vendo | openui | openui Query/Mutation bindings |
| --- | --- | --- | --- | --- | --- |
| maple | smoke | show my account balances at a glance | ok 12.7s 2f | ok 2.9s 0f | host_getProfile, host_listAccounts |
| maple | smoke | let me transfer money between my accounts | failed 17.3s | ok 23.1s 0f | host_listAccounts, host_transferMoney |
| maple | smoke | show my recent transactions with search | failed 2.9s | ok 2.9s 0f | host_listTransactions |
| cadence | smoke | show my account balances at a glance | refused 2.5s | ok 4.4s 0f | — (fabricated) |
| cadence | smoke | let me transfer money between my accounts | refused 1.3s | ok 7.5s 0f | — (fabricated) |
| cadence | smoke | show my recent transactions with search | refused 1.7s | ok 6.3s 0f | — (fabricated) |
| cadence | cadence | which clients still owe me money, oldest first | refused 2.2s | ok 3.3s 0f | host_listClients |
| cadence | cadence | show me where my money went last quarter | refused 2.0s | ok 6.5s 0f | — (fabricated) |
| cadence | cadence | let me chase every overdue invoice in one go | refused 2.0s | ok 40.0s 0f | host_listClients, host_sendClientMessage |
| cadence | cadence | what's missing before I can close the books this month | ok 27.4s 1f | ok 4.8s 0f | host_listDeadlines |
| cadence | cadence | show revenue by client with a chart, drill into one | refused 1.7s | ok 13.2s 0f | host_getClient, host_listClients |
| cadence | cadence | build me a deadline board for the next 30 days | refused 2.3s | ok 11.9s 0f | host_listDeadlines |
| cadence | cadence | which clients are least profitable (time spent) | refused 2.5s | ok 24.1s 0f | — (fabricated) |
| cadence | cadence | one screen: can I afford to hire someone | refused 1.7s | ok 8.7s 0f | host_getDashboard, host_listClients |
| cadence | (single) | show my clients | failed 1.9s | ok 2.6s 0f | host_listClients |

vendo "failed" rows that are not refusals are generation failures on Gemini
(malformed wire/props the checking layer rejected — each run.json carries the
full error string).

## Island-escape metrics (`measure/`)

**N/A for the openui lane.** The bench's committed measurement
(`measure/metrics.ts`) reads the vendo lane's AppDocument (islands, declared
queries, wire chars) — openui output has no AppDocument, so those columns do
not apply and were not shimmed. Cross-lane comparison here uses the metrics
the RunRecord carries for every lane: status, duration, findings.

## Screenshots

`screenshots/` — one PNG per run: the cockpit with the Vendo and OpenUI panes
side by side (other lanes toggled off; they had no key). The OpenUI pane pins
their light theme on a light canvas (their `ThemeProvider mode="light"`,
scoped to the pane) so their output is legible inside the dark cockpit — their
components, their theme, no re-skin. Named `<host>-<pack>-<slug>--<run>.png`.
