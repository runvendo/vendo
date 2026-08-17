# @vendoai/automations

Runs a principal's automation **records** on schedules, host events, and verified
webhooks while they are away, with captured authority, fail-loud execution, and
one run ledger.

A record has an owner, a trigger, a task (steps or a goal) and — for a goal — the
name of the agent that thinks it through. Agents are code, never stored:
registered by name at boot, looked up at fire time, and a name nobody registered
writes a failed run rather than falling back to another brain. This package has
zero app concepts; a task reaches an app only by naming its function as an
ordinary granted tool.

The unit suites cover trigger dispatch, capture, lifecycle controls, resource bounds, and run status behavior. The full-stack e2e suites compose the real store, guard, actions, apps runtime, fixture host, and both scripted and opt-in live agentic legs.

## Known limitations

- Multi-instance schedule and webhook races are deduplicated when the store exposes the optional atomic-record capability. Adapters without it retain the single-instance fallback.
- In-process goal runs are aborted by `runs.stop()` through the optional runner signal. Cross-instance stop remains best-effort through the persisted stopped-row check.
- Goal enable-capture proposes the full bound surface until a proposal seat exists; approve selectively.
- JSONata evaluation is not CPU-timeboxed.

Read [Automations](https://docs.vendo.run/capabilities/automations).
