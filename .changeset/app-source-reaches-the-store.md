---
"@vendoai/apps": minor
"@vendoai/harnesses": minor
"@vendoai/vendo": minor
---

An app's code reaches the store, so the box is disposable.

`AppDocument.source` and the `checkoutApp`/`commitApp` seam landed with the
contract but with ZERO production callers: every build still persisted code only
into the sandbox snapshot behind `machine.snapshotRef`, so losing a snapshot lost
the customer's app. This wires the commit half in.

- `RenderSeamOptions.commitSource` is the sibling of `authoredApp` on the SAME
  interception point. `commit()` is the store-write moment, and the reason is the
  one already stated in `render-seam.ts`: the sandbox sync-back path commits
  without ever calling `writeFile` on this façade, so a builder working inside a
  box reaches the store here and nowhere else. It runs once per APP a commit
  touched, with `CommitResult.changed` verbatim; a `conflict` result persists
  nothing, because nothing landed.
- `AppsRuntime.commitSource` is the store half, binding `commitApp` to the app
  row's ownership (§9.7 — the address comes from the owner, never from which
  mount happens to be writable), its compare-and-swap update, and — new —
  `AppsConfig.files`, the SAME `FilesAdapter` the workspace rows spill to.
- The `HOT_PATH` regex became one `APP_PATH` regex with the filename as a tail,
  so "which app is this path in?" has one answer for the hot paths and the source
  tree alike. No second path reader.
- Source persistence can never fail the commit it rides on, exactly as a view
  cannot — but a silently dropped source file is a lost app, so a failure is
  logged loudly rather than swallowed.

`machine.snapshotRef` is now a cache in fact and not only in the doc comment: the
audit found no reader of it anywhere that recovers source (`SandboxMachine` has no
file-read method at all), and the new seam test deletes an app's snapshot, proves
`resume` fails, and rebuilds the app from its row alone into a store that has
never held its files — byte for byte, including a file past the inline cap so the
blob-spill leg is proven too. `trigger`, `placements`, grants and the app's id all
ride through untouched: a commit is not a generation.
