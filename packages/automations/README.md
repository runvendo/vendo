# @vendoai/automations

Runs Vendo apps on schedules, host events, and verified webhooks while a user is
away, with captured authority, approval-aware execution, and run history.

The unit suites cover trigger dispatch, capture, parking and resume, lifecycle controls, resource bounds, and run status behavior. The full-stack e2e suites compose the real store, guard, actions, apps runtime, fixture host, and both scripted and opt-in live agentic legs.

## Known v0 limitations

- Agentic runs do not park; a parked agentic call queues an approval which, when approved, grants the next firing.
- Multi-instance schedule, webhook, and resume races are deduplicated when the store exposes the optional atomic-record capability. Adapters without it retain the single-instance fallback.
- In-process agentic runs are aborted by `runs.stop()` through the optional runner signal. Cross-instance stop remains best-effort through the persisted stopped-row check.
- Agentic enable-capture proposes the full bound surface until a proposal seat exists; approve selectively.
- JSONata evaluation is not CPU-timeboxed in v0.

Read [Schedulers and webhooks](https://docs.vendo.run/deploy/scheduler-and-webhooks).
