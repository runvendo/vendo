---
"@vendoai/vendo": minor
---

A deployment enrols itself with Vendo Cloud at boot, and derives the secret Cloud signs its wake-up call with.

Nothing in this repo ever told Cloud that a deployment existed, so the heartbeat had no door to knock on: a hosted deployment served every request, armed its automations, and fired none of them — with no error anywhere to say so.

**If you set `VENDO_API_KEY` and `VENDO_BASE_URL`, there is nothing else to do.** On the first request after boot (the same `ready()` latch the schema and the boot reconcile ride — construction stays free of I/O for Workers' sake), the deployment posts its own URL and a tick secret to Cloud, and that is the entire enrolment: no dashboard step, no second env var, nothing for a person to configure. Registering is idempotent on (project, host), so every replica and every redeploy calling it is the expected usage, and a re-register also clears Cloud's failure breaker. `VENDO_CLOUD_URL` repoints the console as everywhere else.

The secret is DERIVED, not configured:

```
HMAC-SHA256(key = VENDO_API_KEY, message = "vendo:automations:tick:v1")  →  base64url
```

Every replica derives the same value, which is the point: they all enrol, and a secret that differed per instance would break the others' knock. The label is frozen for the same reason. It is never logged, never in an error message, and never in a URL.

## Whether you still need `VENDO_TICK_SECRET`

This supersedes the "with `VENDO_TICK_SECRET` unset, both are refused" line in the tick-door note. `POST /api/vendo/tick` now verifies against the derived secret too, so:

- **On Vendo Cloud** — you do not need `VENDO_TICK_SECRET`. Remove it if you set it only to make the heartbeat work.
- **Running your own cron, no Cloud key** — you still need it, exactly as before. Nothing changes for you.
- **Both set** — `VENDO_TICK_SECRET` wins. It is the bring-your-own override, and it is *that* secret that gets registered with Cloud, so your cron and Cloud's heartbeat present the same one and both legs work.

With neither set the door still refuses every knock, and its 401 now names both roads out.

## When it cannot enrol, you hear about it

Enrolment never throws and never delays a request — a console blip must not take a deployment down or hold up its first response. It logs at `error` under the code `vendo.tick-enrolment-failed`, once per composition, because an unenrolled deployment is otherwise indistinguishable from a healthy one: it serves everything correctly and fires nothing. Two reasons produce that line — Cloud refused the registration, or `VENDO_BASE_URL` is unset so there is no public URL to publish. If you see it, your scheduled automations are not running.

It stays silent where there is nothing to publish and nothing wrong: no Cloud key, `automations: false`, and a development process — which fires its own ticks already and sits behind a URL no heartbeat could reach.

`vendo doctor` reads the same ladder the door does, so a Cloud deployment that configured nothing no longer reports itself as having no schedule caller.
