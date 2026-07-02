# Morning Document Chase — Cadence Demo Runbook

Everything to run the Flowlet × Cadence beat on stage, reset it, and recover if
it misbehaves. The beat: the user asks Vendo (the embedded Flowlet agent) to
set up a standing automation in plain English; it compiles an inspectable
AutomationCard; one approval, one force-fire, and **real** emails go out and
**real** calendar events get booked.

## Start

```bash
pnpm demo:accounting
```

(= `infisical run --projectId=b366cac7-1716-47a0-9617-f335500f6dee --env=dev -- pnpm --filter demo-accounting dev`)

Open **http://localhost:3000**. Secrets come from Infisical (`dev`):
`ANTHROPIC_API_KEY`, `COMPOSIO_API_KEY`. No keys are committed. Model:
`claude-sonnet-4-6` (override with `FLOWLET_DEMO_MODEL`).

Three Flowlet surfaces are live:
- **Vendo page** — "Vendo" in the left sidebar (`/assistant`): the full agent page.
- **Cmd/Ctrl+K overlay** — summon the same agent over any page.
- **Dashboard slot** — the "Design a view" card at the bottom of the dashboard.

Gmail + Google Calendar show connected in the composer's connect tray (2
connected). There is no on-screen connect flow — they are the firm's standing
integrations, pre-authorized for the Composio subject `flowlet-demo`.

## Before you walk on stage — reset + reseed

Press **Cmd/Ctrl+Shift+.** (period) anywhere. This restores the seeded firm and
reloads to a clean thread. **Reseeding is what keeps the deadlines in-window:**
the seed anchors deadlines to *today*, so Rivera lands 2 days out and Chen 3
days out — both inside the automation's 3-day window, both still missing
documents. If you demo without reseeding after the app has been up a while,
those two deadlines are still relative to the boot date, which is fine same-day
but drifts across days. **Reseed right before you demo.**

Reset also recreates the automations world (any automation you built is gone)
and clears the same-day send-dedup (see Idempotency below), so the next run
sends fresh.

## The beat, on stage

1. Open the **Vendo** page (or Cmd/Ctrl+K). Type verbatim — it is also a
   suggestion chip:

   > every morning, email any clients missing docs. If anyone is within 3 days of a deadline, book a call with them on my calendar

2. Vendo compiles it into an **AutomationCard**: trigger `0 8 * * *`
   (America/Los_Angeles), a `get_deadlines` read, a `for_each` that emails every
   `missing_docs` client, a `for_each` that books a call for anyone
   `daysUntilDeadline <= 3`, and grants for the two sends. Read it aloud — the
   whole point is that it is inspectable — then **Approve automation**.

3. To fire it now instead of waiting for 8 AM, type:

   > run it now for real

   Approve the run-now card (it is itself approval-gated). You get **8 real
   chase emails** (to `yousef+<client>@vendo.run`, so they land in your own
   inbox) and **2 real calendar events** (Rivera, Chen), plus a rendered run
   history.

### Dry-run gotcha — the #1 thing to know

`run_automation_now` **defaults to a dry run** (mutating tools are simulated,
nothing real is sent). The agent only fires live when the user is explicit.
**If a run shows no real sends, that's the dry run** — just re-ask:

> run it live, actually send them

Have that phrase ready. Saying "for real" / "actually send" in the prompt is
what flips `live: true`.

## Timing gotcha — the 8 AM cron

The automation's real trigger is `0 8 * * *` America/Los_Angeles. The scheduler
is driven by a client heartbeat (`POST /api/flowlet/tick` every ~30s). **If the
wall clock crosses 8:00 AM PT while the app is running with an approved
automation, it can fire on its own** — sending the real emails/events
unprompted. For a controlled stage demo, either demo away from ~8 AM PT, or
reset (which drops the automation) between takes so nothing is armed when you
are not looking.

## Idempotency — safe to rehearse

Each real send is deduped by `(recipient, day)` for email and
`(attendee/summary, event-day)` for calendar, world-scoped. So **a second
force-fire the same day does not double-send or double-book** — the repeat run
still succeeds but the sends are skipped. A reset (new world) clears the dedup
and lets the next run send fresh. Rehearse freely; reset before the real take
if you want the emails to actually go out again.

## Stall protection

Every real Composio call has a 15-second timeout (AbortController). If Gmail or
Calendar stalls mid-send, the step **fails loud into run history** ("... timed
out after 15000ms") instead of leaving the stage spinning. If you see a
timeout, reset and retry — it is almost always transient.

## Recover if a beat misbehaves

- **No real sends** → dry run; re-ask "run it live, actually send them".
- **"items expression did not produce an array"** → the agent mis-compiled the
  `for_each`; it usually self-corrects if you say "keep the deterministic spec,
  the items filter needs the `{{ }}` braces and `output.clients`". Or reset and
  re-ask from scratch.
- **Calendar booked but emails didn't (or vice-versa)** → check the rendered run
  history for the failed step's error; reset and retry.
- **403 on chat/tick** → you are not on `localhost` (or `NODE_ENV=production`
  without the opt-in). Real Composio identity is attached only for local runs;
  set `FLOWLET_DEMO_PUBLIC=1` to intentionally enable a deployment.
- **Nuclear option** → Cmd/Ctrl+Shift+. to reset, reload, start clean.

## What is real vs staged

Real: the agent (Claude), the compiled automation, the generated UI, the run
history, **the Gmail sends and the Calendar events** (verify in the
`yousef@vendo.run` inbox / calendar). Staged: the firm and its clients are
seeded fiction; client emails are plus-addressed to the demo inbox on purpose so
live sends never reach a stranger.

## Pre-flight (once, before the session)

Confirm the Composio connections are live for `flowlet-demo`:

```bash
infisical run --projectId=b366cac7-1716-47a0-9617-f335500f6dee --env=dev -- \
  node -e "const k=process.env.COMPOSIO_API_KEY;const A='https://backend.composio.dev/api/v3';(async()=>{for(const s of ['GMAIL_GET_PROFILE','GOOGLECALENDAR_LIST_CALENDARS']){const r=await(await fetch(A+'/tools/execute/'+s,{method:'POST',headers:{'x-api-key':k,'content-type':'application/json'},body:JSON.stringify({user_id:'flowlet-demo',arguments:{}})})).json();console.log(s, r.successful?'OK':'FAIL')}})()"
```

Both should print `OK`. If not, the Gmail/Calendar connection for `flowlet-demo`
has expired — reconnect it in the Composio dashboard for that subject.
