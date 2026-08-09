---
"@vendoai/core": minor
"@vendoai/harnesses": minor
"@vendoai/apps": minor
---

Opt-in OTel GenAI telemetry: a host that registered a tracer provider now sees
Vendo's model calls

The ai-SDK emits OpenTelemetry GenAI spans only when a call passes
`experimental_telemetry`; it is off by default so a library never exports a
host's prompts unasked. Vendo never passed it, so a host with OTel already
registered saw NOTHING from any Vendo model call — silently, with no warning and
no error to hint at it.

Measured in a third-party Next.js host: a 4.4-minute turn that generated a
working app produced zero spans. With `VENDO_OTEL_TRACING=1` the same prompt
yields cost per turn, the model ladder escalating mini -> full, the whole tool
graph, and the app-repair lane firing — and, within the hour, surfaced a failing
turn (`AI_APICallError`, `isRetryable: false`) that was otherwise invisible.

No new dependency and no vendor coupling: the ai-SDK resolves whatever provider
the host registered through `@opentelemetry/api`, and Vendo runs inside the
host's process, so the spans join what is already there.

Off by default; `otelTelemetry()` returns `{}` unless `VENDO_OTEL_TRACING` is
set, so behaviour is unchanged for every existing host.
