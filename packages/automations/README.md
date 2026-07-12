# @vendoai/automations

Apps that run on schedules, host events, or verified external webhooks while the user is away. The package supports deterministic step pipelines, agentic runner reports, enable-time authority capture, approval-backed step resume, and run observability.

The unit suites cover trigger dispatch, capture, parking and resume, lifecycle controls, resource bounds, and run status behavior. The full-stack e2e suites compose the real store, guard, actions, apps runtime, fixture host, and both scripted and opt-in live agentic legs.

## Known v0 limitations

- Agentic runs do not park; a parked agentic call queues an approval which, when approved, grants the next firing.
- Single-instance deployment is the supported v0 topology. Multi-instance deployments can double-fire on exact schedule, webhook, or resume races until the store grows an atomic claim primitive.
- Agentic enable-capture proposes the full bound surface until a proposal seat exists; approve selectively.
- JSONata evaluation is not CPU-timeboxed in v0.
