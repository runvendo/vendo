---
"@vendoai/vendo": minor
---

`vendo doctor` checks what is on disk and nothing else. It starts no server, makes no HTTP request, and needs no running app: it grades your wiring markers, your `.vendo/` files, your installed `ai` and `zod`, your ejected surfaces, your `server.json`, and the environment variables the install depends on. Run it any time, in any repo, and it answers in under a second.

The promise on every install prompt is "you're done when `vendo doctor --json` reports all green", and on the exact stack Vendo recommends that was unreachable. Doctor probed the running app over plain HTTP with no browser session, so an app with a signed-in-user auth preset correctly answered 403, and doctor exited 1 with `E-LIVE-001`, `E-AUTH-003`, `E-AUTH-006` and `E-TURN-002`. A green run now means what it says.

What went with the probes: `vendo doctor --url` and `vendo doctor --yes`, the `liveTurn` field in the `--json` object, the dev-server-start offer, the live model turn, the `/status`, present-credential, actAs, machines and MCP discovery requests, the npm-latest version hint, and the split-brain version-skew read. The `/doctor/*` routes on the server side are unchanged. These error codes are retired and doctor can no longer emit them: `E-DEP-002`, `E-DEV-001`, `E-LIVE-001` through `E-LIVE-006`, `E-AUTH-001` through `E-AUTH-008`, `E-MCP-001`, `E-MCP-002`, `E-MCP-003`, `E-MCP-005`, `E-MCP-008`, `E-SCHED-001`, `E-TURN-001` and `E-TURN-002`. Each keeps its troubleshooting page, marked retired, so an old report still resolves.

The seams doctor cannot see, it no longer pretends to: your auth forwarding, your actAs resolver and your model credential are proven by one real call in your own app, not by a synthetic probe against a route your users never hit.
