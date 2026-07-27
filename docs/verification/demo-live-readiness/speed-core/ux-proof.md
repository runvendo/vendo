# speed-core — live UX proof (criterion 7)

- Date: 2026-07-26 · surface: real demo-bank dev (`MAPLE_STORE=local`, BYO `ANTHROPIC_API_KEY` — sonnet full + haiku paint via the ladder), real login (`yousef@maple.com`), overlay opened via the "Ask Maple" launcher.
- Off-script prompt: "Put together a weekend spending review: what I spent on food and fun last week, versus my budgets."
- Recording: `maple-create-ux.webm` (captured by `scripts/capture-maple-speed.mjs`); timestamped stills below, offsets measured from pressing Enter.

| frame | offset | what the screen shows |
|---|---|---|
| maple-t+1s.png | **+1.8s** | "Generating…" beat + three-line skeleton — first visual paint, no dead air |
| maple-t+3s.png | +5.1s | "Vendo apps create… 0.4s · step 3 of 3" — staged tool tracker (steps tick live) |
| maple-t+10s.png | +14.3s | tracker still ticking (staged, not static) |
| maple-t+20s.png | +25.1s | "Building your view…" + animated build placeholder |
| maple-t+40s.png | +45.8s | the finished app: spending donut (TOTAL $4,992.08) + per-category budget bars |
| maple-final.png | ~+66s | complete: app + the agent's summary prose |

Verdict: first visual paint ≤ 5s (**1.8s**), staged progress the whole way (beat → step tracker → build placeholder → painted app), never a static spinner, no dead air. Criterion 7 met on the local prod-posture run (final deploy happens at land stage per the criterion).

Note (unrelated defect, not fixed here): in this run the generated budget bars read "of $60,000.00" where the host budget limit is 60000 **cents** ($600) — the cents-as-dollars class on generated labels (an earlier run of the same prompt rendered "$357.09 of $600.00 · 60%" correctly, so it is intermittent generation quality, not a host-data bug). Also observed once on an earlier run: a transient red "app not found: app_…" chip inside the app card (~t+20s) that self-healed — likely the embed's open() racing the record persist.
