---
"@vendoai/vendo": patch
"@vendoai/automations": patch
---

A development process fires its own scheduled automations. Two gaps compounded into armed-and-never-fired schedules on every local deployment: under the hosted store the composition deferred schedule/external firing to Cloud's scheduler unconditionally — but Cloud cannot reach a dev server (a localhost wire is in no deployment inventory), so nobody fired; and even self-hosted, the local tick is an external caller's job (`POST /tick` with `VENDO_TICK_SECRET`) that no laptop has. Now a development composition keeps schedule firing local (the schedule-cursor claims are atomic in the shared store, so a second firer can never double-run a tick) and arms the engine's own minute ticker from the ready() latch — the same Workers-safe arming the background sweep uses, unref'd so it never keeps a dev server from exiting. Deployed processes are unchanged: hosted deploys leave firing to Cloud, self-hosted production still uses the external tick caller. The hosted-store boot notice tells the development story honestly.
