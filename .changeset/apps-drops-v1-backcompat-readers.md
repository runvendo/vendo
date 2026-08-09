---
"@vendoai/apps": minor
---

Three v1 back-compat readers leave the runtime. A production-data audit across
all 84 Cloud tenant schemas and the console mirror (898 app documents) found
ZERO rows carrying any of the three shapes, and every name was re-grepped across
`packages/`, `examples/`, `fixtures/`, `corpus/` and `scripts/` before removal.

**The e2b v1 snapshot-ref decoder is gone.** `decodeSnapshotRef` accepts only
`e2b:v2:` refs now; the `e2b:v1:` prefix, its `egress` → `allowedDomains`
mapping, and its mention in the validation error are deleted.

> **BREAKING for self-hosted deployments:** pre-v2 e2b snapshot refs are no
> longer resumable; re-create the app's box.

Nothing else about the v2 path changes — the ref format, the `sourceSandboxId`
reap-on-destroy, the port and allowlist round-trip are all untouched.

**The retired v1 `server` field readers are gone.** `rungFor` no longer consults
`app.server`, the fork no longer strips it, and interchange no longer lists or
omits it — the field is dropped from `APP_DOCUMENT_FIELDS`, so a document that
smuggles one is stripped by the allowlist exactly as any other unknown field is.
Rung 4 stays: it is a served document with no machine (a de-graduated doc), which
is still reachable and still has no surface. The singular `trigger` → `triggers`
import migration beside it is UNTOUCHED — production documents still carry the
singular key, and that migration is alive.

**The legacy scheduler-state migration is gone.** The `vendo_app_schedules`
cache, the `carryLegacyCursors` cutover that carried its `lastFiredAt` onto the
new per-trigger cursor, and `clearLegacyState` (with its one caller in
`apps.delete`) are deleted. The apps-side write into the automations-owned
`automations:schedule` collection existed solely for that cutover and goes with
it, as its own comment said it would. The successor cursor path in
`@vendoai/automations` — the one the engine actually reads and writes — is
untouched.
