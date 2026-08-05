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

Two things that ride along, because this PR is `commitApp`'s first real caller and
both only become reachable with one:

- **`commitSource` is a new authorization surface, so it is tested hostilely.** The
  appId it writes to is derived from the COMMITTED PATHS, and a caller may write
  anything under their own `/user` mount — including another person's app
  directory. Three cases are now pinned: a foreign caller is refused and the
  refusal is AUDIBLE rather than a silent skip; an org-owned app resolves to its
  ORG address even when the caller's personal mount is writable too; and a commit
  naming a stranger's app alongside the caller's own lands nothing on the
  stranger's while still landing the caller's. All three pass against the gates
  Phase 0 already put in — these document them, they do not add them.
- **"Would not read" is no longer treated as "was deleted."** `commitApp` decided
  deletions by whether the read-back threw, and for a spilled file that read is a
  live fetch from the files adapter — so a blob store having a bad minute looked
  exactly like a deletion and the entry was dropped. Now a path that still EXISTS
  but will not read keeps its stored entry and says so loudly; only a confirmed
  absence is a deletion. Per path, so the rest of the commit still lands.
