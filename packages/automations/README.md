# @vendoai/automations

Apps that run on schedules, host events, or verified external webhooks while the user is away. The package supports deterministic step pipelines, agentic runner reports, enable-time authority capture, approval-backed step resume, and run observability.

The unit suites cover trigger dispatch, capture, parking and resume, lifecycle controls, resource bounds, and run status behavior. The full-stack e2e suites compose the real store, guard, actions, apps runtime, fixture host, and both scripted and opt-in live agentic legs.

## Known v0 limitations

- Agentic runs do not park; a parked agentic call queues an approval which, when approved, grants the next firing.
- Multi-instance schedule, webhook, and resume races are deduplicated when the store exposes optional `RecordStore.claim`. Adapters without it retain the single-instance fallback.
- In-process agentic runs are aborted by `runs.stop()` through the optional runner signal. Cross-instance stop remains best-effort through the persisted stopped-row check.
- Agentic enable-capture proposes the full bound surface until a proposal seat exists; approve selectively.
- JSONata evaluation is not CPU-timeboxed in v0.
