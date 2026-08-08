---
"@vendoai/core": patch
"@vendoai/store": patch
"@vendoai/apps": patch
"@vendoai/ui": patch
"@vendoai/vendo": patch
---

Remove undo and rollback entirely.

**BREAKING, despite the patch version.** This release ships as a patch off the
0.8 line (pre-1.0 convention), so the version number does NOT signal the removal
below. If you call any export in the lists that follow, this release breaks your
build — read them before upgrading. A `0.8.x` range accepts this version, so the
version number alone will not hold it back.

Two separate features, both cut: rolling an app back to a previous version, and
walking a workspace file back to the version before its newest commit. **Users
lose the ability to roll an app back.** That is deliberate. Pre-1.0, so this is
a hard cut with no deprecation shim.

Version history LISTING stays, everywhere: the app's capped 50-entry version log
and the workspace's per-path revision trail are unchanged, and so is everything
built on the recorded history — the review venue's newest-approved-version serve
(`review.serveDocFor`), the pin-rebase replay trail (`history.pinIntents`), and
the edit journal's append/discard/prune.

Removed from `@vendoai/apps`:

- `AppsRuntime.history(appId, ctx).undo()` — the surface now returns
  `{ list(): Promise<VersionEntry[]> }` only
- `AppHistoryAccess.surface(appId).undo()` (the `createAppHistory` internal)

Removed from `@vendoai/core`:

- `StoreOps.workspace.undo(target, opts)`
- `storeWireWorkspaceUndoRequestSchema`
- the `"workspace.undo"` key from `STORE_WIRE_PATHS`, so the store wire is
  **31 doors, not 32** — `StoreWireStatus.ops` is now `31`, and the workspace
  family is 4 (index · read · commit · history)
- the `workspace.undo` cases from the `storeOpsConformance` suite, and the
  `undo` implementation from `memoryStoreOps`

Removed from `@vendoai/store`:

- `workspaceStore(store).undo(caller, path)`
- `WorkspaceRows.undo` and the `UndoOutcome` type (internal — never exported
  from the package index)
- `createStoreOps(store).workspace.undo`, with its `pathsMovedOn`,
  `newestCommitTouching` and `commitCreated` helpers and the `created` array
  the commit ledger wrote for them
- the `recordHistory` option on the internal write path, whose only `false`
  caller was undo — every landed write now records its superseded revision

Removed from `@vendoai/ui`:

- `VendoClient["apps"].undo(id)`
- `useApp().history.undo()` — the hook's `history` is now `{ list() }`

Removed from `@vendoai/vendo`:

- the `POST /apps/:id/history` route (the `{ op: "undo" }` body). `GET
  /apps/:id/history` is unchanged; the path now serves GET only
- the `workspace.undo` leg of the hosted (Cloud) store adapter, which called
  the console's `POST /workspace/undo`

**Existing data is left exactly where it is — no migration, no cleanup.**
Existing `vendo_workspace_history` rows and `vendo:app-history:*` records stay
readable by listing, but the content they hold becomes unrestorable: nothing
reads it now. Those rows self-trim at `WORKSPACE_HISTORY_LIMIT` per path, except
for a deleted path that is never written again, which holds its blob forever.
That is a real consequence of removing the feature, and it is not repaired here.
