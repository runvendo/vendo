# ENG-289 Child B: Custom fields substrate — milestone plan

Date: 2026-07-14. Owner: child-B orchestrator (this session). Spec: `docs/superpowers/specs/2026-07-14-apps-block-design.md` (locked). Issue: ENG-289.

## Audit baseline (verified in code)

- `packages/apps/src/proxy.ts` serves only `POST /tools/<name>` and `GET|PUT /state`.
- `packages/apps/src/app-data.ts` has `getState`/`setState`/`clear` only; `resolveAppStorage` already maps declarations to `app:<appId>:<name>` collections but nothing calls it outside `clear`.
- `packages/apps/src/agent-tools.ts` exposes create/edit/open only.
- Core `RecordStore.list({ refs })` filtering exists and is conformance-tested; `StorageDecl.refs` values are validated against `^host\.` and then never consumed.
- Rung-1 tree queries (`{ tool, input, path }`) resolve **sequentially, server-side** in `open.ts` — this is the join seam. UI actions route through `AppsRuntime.call(appId, ref, ...)` — same interception point.

## Join query encoding (deferred design item — needs parent sign-off before M2)

**Recommendation: reserved `vendo.data.*` refs resolved inside the apps runtime. No core/tree wire-format change.**

- Tree queries and actions may name `vendo.data.list | get | put | delete | join`. Core tree validation already accepts these (any non-empty tool string); the apps runtime intercepts the `vendo.data.` prefix in `open()`/`call()`/`callQuery()` before the guard-bound host registry — exactly how `fn:` is special-cased today. Scoped to the calling user's own app instance (appId + subject from ctx), like `/state`; no guard prompt, matching the one-security-rule (app data belongs to the user's copy).
- `vendo.data.list` input: `{ collection, refs?, limit?, cursor? }` — collection must be declared in `storage`.
- `vendo.data.join` input: `{ source: <JSON pointer into tree.data>, collection, on?: { host?: string = "id", ref: string }, into?: string = "vendo" }`. Queries resolve in document order, so a join query placed after a host-tool query reads its rows at `source`, fetches app records via `RecordStore.list({ refs: { [on.ref]: String(row[on.host]) } })`, and merges each matched record's `data` under `row[into]`. Result written at the join query's own `path`.
- **Host-entity key convention**: the declaration's ref key IS the join key. `storage.fields.refs = { invoice_id: "host.invoice" }` ⇒ records carry `refs.invoice_id = <host invoice id, stringified>`; SQL hosts join via `refs @> jsonb_build_object('invoice_id', ...)` per 02 §2; tree joins name the same key in `on.ref`. Host rows are keyed by `id` by default, overridable via `on.host`.
- Rejected alternative: an optional `join` clause on `TreeQuery` in core — touches the frozen `vendo-genui/v1` wire format and the renderer for zero added power.

## Milestones (each a PR, gates green before each)

1. **M1 — Data plane** (no dependency on join sign-off; starts immediately)
   - Extend `AppDataAccess`: records + files access, gated on the app's `storage` declarations, reserved-name and size caps mirroring `/state` (256 KB records; pick a blob cap and note it).
   - Proxy routes for machines: `/data/<collection>` + `/data/<collection>/<id>` (list/get/put/delete, refs filters), `/files/<collection>[/<key>]`.
   - Agent data tools in `agent-tools.ts`: `vendo_apps_data_list` (read), `vendo_apps_data_put`, `vendo_apps_data_delete` (write) — ownership-checked, declaration-gated.
   - Enforce that written `refs` keys match the collection's declaration and values are non-empty strings.
2. **M2 — Refs join + rung-1 tree binding** (gated on parent sign-off of the encoding above)
   - Intercept `vendo.data.*` in open/call/callQuery; implement list/get/put/delete/join semantics; batch the join's record lookups.
   - Tests: rung-1 tree with a host-tool query + join query renders joined rows; reload (fresh `open()`) reproduces them.
3. **M3 — Org-install shapes + cloud-required + shared-write policy shape**
   - `OrgInstall` + shared-instance types and zod schemas, runtime entry throwing `cloud-required` exactly like `cloud.ts` share/publish; `SharedWritePolicy` host-policy shape for writes to shared fields; additive contract-doc note. Records the interface Cloud implements (standing Cloud-alignment agenda).
4. **M4 — Cadence demo + mandatory GIF**
   - Real browser: Cadence user adds a "priority" field to invoices via the agent, tags invoices, generated UI shows fields joined onto the real invoice list, survives reload. GIF captured and attached to the PR. Docs synced.

## Coordination

- All coding delegated to codex sol in this worktree; Opus 4.8 only if sol is usage-blocked.
- packages/apps merge conflicts with children A (remix/in-client) and C (venues) brokered by the parent; my files of concern: proxy.ts, app-data.ts, agent-tools.ts, call.ts, open.ts, runtime.ts, cloud.ts.
- Anything cut is filed as a Linear issue, never silently dropped.
