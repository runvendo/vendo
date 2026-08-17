---
"@vendoai/vendo": minor
"@vendoai/core": minor
---

One automations engine per deployment, the brains a firing can reach named at composition, and `POST /api/vendo/tick` the only door that wakes it.

The whole public surface:

```ts
vendo.agent                                   // the agent this deployment adopted, read back
createVendo({ agents: [support, billing] })   // MORE brains, resolvable by name
vendo.automations.list / get / enable / disable
vendo.automations.runs.list / get / stop / rerun
vendo.automations.dryRun
```

`createVendo({ agents })` is registration only — nothing in that list serves chat turns. It makes a name resolvable, so a firing declared by `support.on(...)` lands on `support`. (`agent:` is the different, existing key: that one this deployment ADOPTS, taking its harness, store and instructions.) A firing's brain is looked up BY NAME at fire time and registered at BOOT, so two agents wearing one name throw during `createVendo` rather than at 2am, when the lookup would already have reached the wrong brain. A name nobody registered is a loud FAILED row in the run ledger and never a fallback brain: the wrong agent acting with the owner's grants is worse than nothing running, because nobody would ever find out.

**There is deliberately no public `create`.** The one create operation is internal, so a host that can observe automations and switch them off still cannot mint one; `vendo_automate`, `vendo_make`'s sugar, the `vendo.json` fold-in and `agent.on` are the four doors in.

## The firing door

`POST /api/vendo/tick` takes two credentials side by side, both verified against `VENDO_TICK_SECRET`:

- `Authorization: Bearer $VENDO_TICK_SECRET` — your own cron (a Vercel cron, a GitHub Action, crontab).
- A standard-webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`) over the EMPTY body — Vendo Cloud's heartbeat. This leg is new.

You configure one thing and either waker works. **With `VENDO_TICK_SECRET` unset, both are refused**, Cloud's heartbeat included, so a deployment with no secret fires nothing — if you read that env var as the BYO-cron credential only, set it now. The door answers `202 {"fired":n}`, and its idempotency is the engine's own atomic cursor claim rather than anything the door asserts, so a duplicate knock claims nothing and honestly says `{"fired":0}`.

The signed leg keys the HMAC on the DECODED secret. A standard-webhooks secret is random bytes carried as base64url text, and a door that hashed the text's own characters would have answered 401 to every signed knock forever. This one calls the engine's `verifySignature` — the same function the per-record webhook path uses — so there is one implementation of the scheme and a test cannot agree with a wrong door. A host who chose a passphrase rather than base64url still gets a working bearer and simply never matches on this leg.

`localFiringKinds` is gone from the repo entirely: the engine decides what is due, and the tick is the only thing that asks. The boot reconcile reads the store on the `ready()` latch even with zero `.on()` declarations, because a deployment that just deleted its last one still has stragglers to disarm.

## core

`toTriggerSource` tested `webhook === ""` when the hazard is the key being ABSENT. The webhook arm is the fall-through, so an object naming none of the five `When` shapes — which is what an untyped wire body is, and the admin routes are exactly that caller — walked in and left with `{ kind: "external", connector: undefined }`: an automation nothing can ever trigger, reported to its owner as armed. It is refused now, naming the shapes.
