---
"@vendoai/core": minor
"@vendoai/store": minor
"@vendoai/agent": patch
"@vendoai/actions": minor
"@vendoai/guard": patch
"@vendoai/automations": patch
"@vendoai/vendo": minor
"@vendoai/ui": minor
---

Principals + orgs (ENG-263). Anonymous→signed-in auto-merge: the first authenticated request carrying a valid anon cookie adopts the session's threads/apps/state into the real subject and retires the cookie — idempotently, without ever overwriting an existing row; grants, approvals, and connected accounts deliberately do not migrate (consent doesn't transfer identities). Away re-verification rides actAs: the host declining to mint fails the run closed, and every actAs-authenticated call audits its disposition (`detail.actAs`). Runtime-minted subjects move into the reserved `vendo:` namespace (`vendo:webhook:<source>`); host principal resolvers producing reserved subjects (or org-kind principals) are rejected loudly. Full org semantics land Vendo-owned: `vendo_orgs` + `vendo_org_members` (schema v3), real `kind:"org"` principals (`vendo:org:<id>`), org-owned apps/automations (members run, admins approve and manage, owners control the owner set), org-scoped approvals/grants surfaces, a minimal org management tab in chrome, and org context in the audit trail — all shipped OSS with activation key-gated on the console `/keys/validate` `orgs` capability (posture error without it).
