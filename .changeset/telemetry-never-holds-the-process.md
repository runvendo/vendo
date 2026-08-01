---
"@vendoai/telemetry": patch
---

Telemetry can no longer keep a process alive after its work is done. On a
captive-portal network — one that accepts the TCP connection to the capture
endpoint and then never answers — `vendo init` printed its summary and sat
there for another ten seconds doing nothing; `DO_NOT_TRACK=1` removed the pause
entirely, naming telemetry as the handle. The cause is Node's global fetch
(undici): aborting the request does not destroy a socket that is still
connecting, so it stayed alive until undici's own 10s connect timeout.

The default transport is now a raw request whose socket is unref'd the moment
it exists, so a stranded telemetry POST can never be the last handle holding
the CLI open, under any network condition. The timeout — unchanged at 1.5s — is
now the only thing a caller ever waits on. An injected `fetchImpl` still takes
the fetch path, so hosts and tests that supply their own are unaffected.

Also adds `VENDO_POSTHOG_HOST`, which points capture events at a self-hosted
PostHog instead of the shipped US cloud (`VENDO_POSTHOG_KEY` already set the
project key).
