---
"@vendoai/vendo": minor
---

A top-level `memberships` beside `auth` now throws instead of vanishing.

`createVendo` already refused `principal`, `actAs` and `oauth` alongside `auth`
— one preset or the per-seam keys, never both. `memberships` was missing from
that list, so it was read only when `auth` was unset and otherwise dropped in
silence.

That silence had teeth. An unset memberships seam is exactly how a keyed
deployment opts INTO the Cloud tenant directory, so a host who wrote
`memberships: async () => []` beside an `auth` preset to say "this deployment
has no orgs" was overruled without a word: Vendo built the directory and asked
Cloud who the caller's orgs were.

```ts
createVendo({
  auth: clerk(),
  memberships: async () => [],   // was: ignored. now: throws at compose time.
});
```

The fix is the one the error names — move it inside the door:
`auth: { ...clerk(), memberships: async () => [] }`. A top-level `memberships`
on its own, next to the deprecated `principal` key, is unchanged and still the
per-seam escape hatch it always was.
