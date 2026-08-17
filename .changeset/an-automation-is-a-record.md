---
"@vendoai/core": minor
"@vendoai/store": minor
"@vendoai/automations": minor
"@vendoai/apps": minor
"@vendoai/ui": minor
---

**Breaking.** An automation is a first-class principal-owned RECORD, not an app with a list of triggers. `AppDocument.triggers` is deleted, every automation verb keys off one automation id, and stored automations are NOT migrated — they stop firing at the upgrade and have to be authored again.

**Tell your users before you deploy this.** Their existing automations lived inside `AppDocument.triggers`; nothing reads that field any more, and nothing converts one into a record. They re-create them (`agent.on(...)` in your code, or by asking in chat). Their run history goes too: `vendo_runs` is emptied once, because an app-keyed run row has no read path and no erase selector left to reach it.

## What breaks in your code

**`@vendoai/core`.** `AppDocument.triggers` is gone, and these exports with it: `Trigger`, `triggerSchema`, `RunModel`, `runModelSchema`, `DEFAULT_TRIGGER_ID`, `TRIGGER_ID_PATTERN`, `triggerKindRefKey`, `TRIGGER_KIND_REF_KEYS`, `TRIGGER_KIND_REF_PRESENT` and `triggerKindRefs`. An app now holds at most `automations?: AutomationId[]` — a list of NAMES the apps layer maintains and resolves on read, not a foreign key, so dead ids simply drop out and there is no cascade to run. Writing `triggers` into an app document arms nothing. New in `automation.ts`: `AutomationRecord`, `When` and the one `toTriggerSource` converter, `AutomationTask`, `Budget`, `automationHash` and `reconcileAutomations`. `TriggerRef.id` is `TriggerRef.automationId`, and `PermissionGrant.triggerId` / `MintGrantInput.triggerId` are `automationId` — a record has no app id for the old pair's other half to name.

**`vendo.automations`.** `enable` / `disable` / `dryRun` take ONE id instead of `(appId, triggerId)`. `list({ owner?, agent? }, ctx)` returns plain redacted `AutomationRecord[]`, deployment-wide. There is **no `app` filter** and there will not be one: a record carries no app reference at all, so an app page filters by resolving its own `automations` list and dropping the dead ids. `runs.list` filters on `{ automationId, owner, agent, status, cursor }`, and `RunRecord.appId`/`.triggerId` become `.automationId` plus `.owner` and an optional `.agent` — one ledger, with the owner, agent and console views as filters over it rather than tables of their own.

**`createAutomations` config.** `apps`, `runner`, `appAccess` (and the `AppAccessSeam` type), `localTriggerKinds` and `AutomationsEngine.onDocumentEdit` are gone; so is the `triggerKey` export. `@vendoai/automations` depends on `@vendoai/core` alone now — a goal run reaches a brain through the named runner map the umbrella registers, and a task reaches an app only by naming one of that app's functions as an ordinary granted tool, which resolves through the bound registry like anything else. Delete an app and its automation still fires, then fails loudly at tool resolution with a `not-found` in the run ledger. The engine no longer watches app-document edits either: sponsorship is bound to the record's own content hash (`automationHash`), so a record whose content changed under a live sponsorship stops on its own. `@vendoai/automations` newly exports `verifySignature`, `signedWebhookBytes` and `base64url` — the one implementation of the standard-webhooks scheme, so the tick door and the per-record webhook path cannot drift.

**`@vendoai/ui`.** `AutomationEntry` IS `AutomationRecord` (`AutomationTriggerEntry` is gone). `client.automations.{enable,disable,dryRun}` take one id; `client.runs.list` takes the new filter. `<AutomationCard>` takes `when` (a `TriggerSource`) plus an already-humanized `action` string instead of `trigger`, and `automationRule(when, action)` takes both halves — a record's task is the producer's to read, and a card that guessed at the words would put them in an automation's mouth.

## What breaks in your store

Schema **v11**. `vendo_automations` is the new table: `subject` is the erase-cascade selector, because a row carries a live webhook signing key and a record that outlived its owner's erasure would be a hole rather than an untidiness; `revision` is the compare-and-swap counter every write bumps. `vendo_runs` re-keys `app_id` to `automation_id` and is **emptied once**, guarded on the old column. `vendo_grants` re-keys `trigger_id` to `automation_id`. The `trigger_kind_*` generated columns on `vendo_apps` are dropped by pattern, so the names leave the codebase entirely. The erase cascade deletes runs BEFORE automations, while the join that identifies them still exists.

`ENGINE_ALLOWLIST_VERSION` goes 2 → 4. `vendo_automations` joins the engine allowlist; `automations:armed` and `automations:webhook` leave it — armed is a FIELD on the record, so a disarm is one write with no second row to keep in step, and the webhook secret lives on the record. If your BYO store pins the allowlist version, bump it.
