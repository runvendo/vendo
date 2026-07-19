# Vendo Cloud — definition, feature split, and realignment

**Date:** 2026-07-17
**Status:** Approved by Yousef (this doc records the decisions; implementation follows in a dedicated realignment lane)
**Supersedes:** the capability-boolean / contract-v2 entitlement model; amends the 2026-07-11 cloud-vs-OSS split with an identity statement; amends PR #355's open question 3.

## Identity

OSS is the whole brain; Vendo Cloud is rentable muscle plus the meeting place.

Every intelligent part of Vendo — runtime, agent loop, guard, UI, actions and
extraction, the store interface — runs inside the customer's app, free,
forever. Vendo Cloud sells exactly two categories:

1. **Infrastructure that is painful to run yourself** (sandbox, inference,
   persistence, connected-accounts broker, MCP broker, hosted automations).
2. **Coordination that is inherently multi-party** (sharing, registry,
   organizations, SSO, billing, the console).

Nothing outside these two categories ever moves cloud-side.

## Rules

**Hard BYO rule.** Every single-player capability keeps a bring-your-own path
with no Vendo API key: own Postgres, own sandbox account, own model key, own
OAuth apps. Cloud-only surfaces are only the inherently multi-party ones.

**Adapter rule.** Every infrastructure-backed block defines one adapter
interface (store, sandbox, inference, connections, broker; knowledge and
memory when they land). BYO implements the interface; Cloud is just another
implementation shipped in OSS. Setting `VENDO_API_KEY` makes the Cloud
implementation the default for adapters the host did not supply; an explicitly
passed adapter always wins. No block contains a hidden key-conditional branch.

**No entitlement protocol.** There are only authenticated service calls. A
Cloud endpoint performs two checks: the key is valid, and — where the
operation consumes a meter — the meter is not exhausted. No capability
booleans, no per-plan feature maps, no license artifacts, no client-side
checks, no validate endpoint. Tiers differ only in meter allowances;
enterprise exceptions are per-org meter overrides.

**Tenancy.** The key identifies the org; tenancy is decided server-side,
never by request claims.

**Invariants kept from today.** Secrets never cross the wire (`vendo_secrets`
is structurally excluded from hosted storage). Guard, approvals, and
permission checks always execute host-side, even when every adapter is Cloud.

## Feature split

| Capability | Free / OSS path (no key) | Cloud path (key selects it) |
| --- | --- | --- |
| Runtime, agent, guard, UI, actions | In the customer's app | never hosted |
| Store / persistence | PGlite or own Postgres | hosted store (#355), `storage_gb` meter |
| Sandbox | Own sandbox account | managed pool, `sandbox_minutes` meter |
| Inference | Own model key | managed inference, passthrough meter |
| Connected accounts | Own OAuth apps / broker | Cloud broker |
| MCP door | Local door + local OAuth | hosted broker per tenant |
| Automations | Local scheduler | hosted runs/deploy, `runs` meter |
| Knowledge / memory | BYO per their project bullets | Cloud-preferred implementations |
| Sharing, registry/publish, pin review, orgs/members/SSO, deployments and usage views, billing, console | — | Cloud-only |

Judgment calls: pin **baselines** stay OSS (hosts serve pins locally; only the
review workflow is Cloud). "Insights" is not a feature — it is console views
over data Cloud already collects. Guard tiers and session replay leave the
vocabulary; guard is one free thing, and replay, if ever built, is judged by
the two categories above.

## Interaction model

One key, one seam: all Cloud endpoints live behind the console. Cloud
adapters attach a deployment-identity header (host, name) to every request;
the console's shared auth middleware upserts the deployment inventory and
meters usage from real traffic. There is no heartbeat: "deployments" means
orgs and hosts recently seen by traffic, not a liveness registry.

`vendo doctor` checks key presence and shape locally; key problems surface on
the first real service call with a clear error. `vendo cloud usage` and the
console pages read the server-side metering.

## Realignment lane (approved: dedicated lane, runs before v2 builds on these seams)

OSS side:
- Delete the entitlement protocol: contract types, entitlements module and
  cache, the `vendo cloud validate` command, and capability display in doctor.
- Rewrite `createConnections` from the hidden key-switch to explicit adapter
  selection consistent with the adapter rule.
- Teach the shared cloud HTTP client to send the deployment-identity header.
- Write the adapter rule and two-category split into CLAUDE.md and docs.

Console side:
- Drop the plan `capabilities` column and plan-capability resolution; the
  three capability checks (share, publish, pin-ship) become valid-key checks.
- Delete the validate route; move deployment upsert and usage metering into
  the shared auth middleware on real service calls.
- Billing, orgs/members/invites, share/publish/pins, hosted runs, sandboxes,
  and the broker stay as they are.

PR #355 (hosted store one-pager): accept, with open question 3 amended from a
per-plan flag to "valid key + storage quota"; questions 1 and 2 accepted as
suggested. It merges as a doc; implementation follows the lane.

Done means: both repos green (build, test, typecheck, lint); the cloud E2E
suite passing against the slimmed surface; zero remaining references to
capabilities or the entitlement contract in either repo; one demo host
exercising a Cloud adapter and a BYO adapter through the same interface.

## Build order after the lane (launch bundle: zero-config dev)

1. **Managed inference** — unblocks the v2 generation bar and the parked
   starter-key flow in `vendo init` (the $0-to-paid conversion moment).
2. **Managed sandbox** — the other half of the <1s/<10s bar; builds on the
   console's existing sandbox API.
3. **Hosted store** per #355.

Knowledge and memory lanes start independently; they are born under the
adapter rule.
