---
"@vendoai/actions": minor
"@vendoai/vendo": minor
---

The component registry has one name: `components`.

The same object was `createVendo({ catalog })` on the server and
`<VendoProvider components>` in the browser — one registry under two names, and
the docs had to explain the seam every time they mentioned it.

`components` is now the canonical `createVendo` key:

```ts
createVendo({ components: registry });   // was: catalog: registry
```

`catalog` still works and is marked `@deprecated`, so your editor points at the
new name and nothing breaks. Setting both throws at composition rather than
silently picking a winner.

`vendo sync` reads either spelling out of your source, so a repo mid-rename
never syncs an empty `.vendo/catalog.json`.

Unchanged: the `.vendo/catalog.json` file, `createVendo({ profile: { catalog } })`
(the in-memory stand-in for that file), and the merge order — explicit
registrations still win by name over the file, which wins over remix holes.
