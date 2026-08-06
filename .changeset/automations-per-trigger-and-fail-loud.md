---
"@vendoai/automations": major
---

**BREAKING:** an automation is now a list of triggers, each armed on its own, and
a run that meets a permission nobody granted fails LOUDLY instead of waiting.

An app used to be one automation with one trigger, so consent, sponsorship,
schedule cursors and runs could all be keyed to the app — arming it once
authorized everything it might ever fire. They are keyed to (app, trigger) now:
`enable(appId, triggerId, ctx)` and `disable(appId, triggerId, ctx)` arm exactly
one trigger, `list(ctx)` answers with each app's trigger LIST (armed state,
sponsor, pending grants and stopped reason per trigger), and `dryRun`/`adopt`
take the trigger too. The waiting state is gone with it: there is no
`"pending-approval"` run and no parked run to resume, because a parked run held
an approval, an identity and an intent open across an unbounded gap that nobody
could see the end of. A run that needs a permission it does not hold ends as
`error` with code `needs-permission`, naming the tool or service it needed, and
`runs.rerun(runId, ctx)` fires the same trigger again on the same event once the
permission is allowed — a fresh run, against live data, with the guard's effect
ledger keeping the work the first attempt already landed from happening twice.

- `RunStatus` no longer has `"pending-approval"`; a status filter that passes it
  is now a validation error.
- `enable`, `disable`, `dryRun`, `adopt` take a `triggerId`; `list` returns
  `triggers[]` per app rather than one trigger's state on the app.
- `runs.list` accepts a `triggerId` filter; `runs.rerun` is new.
- The parked-run collection and its resume path are removed.
