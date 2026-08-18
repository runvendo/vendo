---
"@vendoai/core": minor
"@vendoai/apps": minor
"@vendoai/vendo": minor
---

The stored `tree` leaves the app document. The model never writes layout and no
production door mints a tree-only app — an app IS its `app.tsx`, and its tree is
what RENDERING that produces — so the field, the branch that served it, the paint
path gated on it and the fact checks that walked it are all deleted.

What changes for a host: `AppDocument.tree` is gone from the type and the schema,
and `.vendoapp` no longer carries it. A row written before this still opens — the
field is STRIPPED on the way out of the store and on the way in, never refused —
because such a document opens on its `source` like any other. A document with no
usable source at all now RESOLVES as `{kind:"failed"}` with a reason naming why,
instead of throwing and leaving an embed to poll to its deadline; importing a
`.vendoapp` that holds a layout and no source is refused in the same words rather
than minting a row that can never open.

BREAKING for a host's own checks: a check that read `document.tree` reads
`undefined` now and will never see a tree there again. The rendered tree moves
onto `CheckInput.renderedTree`, beside `document` and `request`, where it belongs —
it is what the person is about to see, not something a document carries — and
every such check must move to that field.

The tree as a RENDER language is untouched — `UIPayload`/`TreeNode`, the
renderer, the streamed view parts, the render seam, and `ui: "tree"` as the
surface kind all stay exactly as they were.
