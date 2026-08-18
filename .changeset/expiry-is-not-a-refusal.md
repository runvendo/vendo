---
"@vendoai/automations": patch
---

An expired arming ask no longer turns the automation off. Live 2026-08-18 on
production Maple, automation atm_d50cd48e: 33 arming asks were created at 11:26,
all 33 were denied at 12:27 — createdAt plus exactly the parked-call TTL — and
the record flipped to armed=false at 12:27:37, with not one human decision ever
recorded. The person's automation turned itself off an hour after they set it up,
silently.

The guard's hour-long sweep denies an abandoned ask as `"system"`, and the
decision subscriber read any deny as a person's "no" and disarmed a consent
moment that had granted nothing. It now reads WHO said no off the approval row —
the provenance the guard already stamps, and which the decision callback (id,
approved) cannot carry — and disarms only for a human. The guard already draws
this line for standing denials, where it enforces only `deniedBy: "human"`; this
was the one place that did not. A guard that stamps nothing keeps today's
behaviour, and a human NO still disarms, so the text channel's "Okay — I turned
it off." stays true.
