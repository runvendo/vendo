# Runtime seam contracts

`packages/vendo-core/src/seams/` defines ten injectable service interfaces. Six belong to the store family: the `Store` aggregate plus `ThreadStore`, `AutomationStore`, `AuditLog`, `GrantStore`, and `CompiledRuleStore`. The other four are `CredentialBroker`, `Executor`, `Scheduler`, and `Channels`. Callers inject only the services required by the runtime or server path they use.

| Interface | Purpose | Provided implementation |
|---|---|---|
| `Store` | Aggregate for threads, automations, audit, grants, and rules | `createInMemoryStore()` in `@vendoai/runtime`; durable thread and automation stores in `@vendoai/store` |
| `ThreadStore` | Principal-scoped chat threads and message streams | in-memory in `@vendoai/runtime`; PGlite/Postgres in `@vendoai/store` |
| `AutomationStore` | Principal-scoped automation records and run history | in-memory in `@vendoai/runtime`; PGlite/Postgres in `@vendoai/store` |
| `AuditLog` | Append and query policy, approval, grant, and automation events | in-memory in `@vendoai/runtime`; host-injected persistence |
| `GrantStore` | Standing user permission grants | in-memory in `@vendoai/runtime`; host-injected persistence |
| `CompiledRuleStore` | Compiled always-ask steering rules | in-memory in `@vendoai/runtime`; host-injected persistence |
| `CredentialBroker` | Authenticate a session and acquire a scoped automation grant | `InProcessCredentialBroker` in `@vendoai/runtime`; host or Vendo Cloud implementation |
| `Executor` | Run a tool call after policy evaluation | `InProcessExecutor` in `@vendoai/runtime`; host or Vendo Cloud implementation |
| `Scheduler` | Fire time-based automation triggers | `InProcessScheduler` in `@vendoai/runtime`; host cron or Vendo Cloud implementation |
| `Channels` | Deliver off-thread messages | `InAppChannels` in `@vendoai/runtime`; host or Vendo Cloud implementation |

All principal-scoped operations use `Principal` (`tenantId` + `subject`). Timestamps are ISO 8601 strings.

## Store

`Store` currently contains `threads`, `automations`, and `audit`, with optional `grants` and `rules`. The store owns record identity and timestamps where its methods create records.

`ThreadStore` persists `VendoUIMessage` streams. `AutomationStore` holds the core automation record and run contract; the runtime extends it with versions, triggers, grants, parked actions, and richer run state. `AuditLog` is append-and-query. `GrantStore` and `CompiledRuleStore` support the trust and steering surfaces.

## CredentialBroker

`authenticate(credential)` returns a verified `Principal`. `acquireGrant(request)` returns a short-lived scoped token for one automation run. Interactive host API calls use the signed-in user's browser session and do not require a brokered grant.

## Executor

`execute(call, context)` returns one non-streaming success or error outcome. Policy evaluates the call before it reaches an executor. `context.grant` is present only for server-executed automation runs.

## Scheduler

The scheduler owns `cron` and `at` triggers. It persists the `Principal` scope with each schedule and replays it in `AutomationFiring`. Host events and Composio webhooks invoke the automation firing path directly instead of passing through `Scheduler`.

## Channels

`deliver(message)` supports message-shaped `in-app` and `sms` delivery. Realtime voice is a session and has a separate contract.

## Direction

Phase 1 is specifying the app artifact as a manifest with optional UI, state, server code, data, files, and a trigger, plus the `core` -> `apps` -> `automations` layering. This document does not define that format or package move.
