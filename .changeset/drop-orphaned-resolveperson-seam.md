---
"@vendoai/core": minor
"@vendoai/vendo": minor
"@vendoai/ui": minor
---

The `resolvePerson` auth-preset hook and the `namesPeople` status field are
removed. Both existed for one reason — telling the Share dialog whether it could
offer to share an app with one named person — and that dialog, with the whole
grants chain under it, was removed in #1108. Nothing has read either since. Every
name was re-grepped across `packages/`, `examples/`, `fixtures/`, `corpus/`,
`docs-site/` and `scripts/` before removal.

> **BREAKING for hosts that wired `resolvePerson`:** the hook is gone from all
> seven auth presets (`identity`, `authJs`, `auth0`, `clerk`, `jwt`, `supabase`,
> and the shared options type). Delete the `resolvePerson:` property from your
> `auth:` config — it is now a type error, not a silent no-op. Nothing else about
> your preset changes, and no behaviour you can observe changes with it: the
> callback has had no caller since #1108.

> **BREAKING for surfaces reading `GET /status`:** the response no longer carries
> `namesPeople`, and `VendoStatus.namesPeople` / `useVendoStatus().namesPeople`
> are gone from `@vendoai/ui`. The field only ever reported whether the seam
> above was wired.

`ResolvedPerson` is gone from `@vendoai/core` — it was the hook's return shape
and had no other producer or consumer.

**Untouched, and deliberately:** `auth.memberships` and `auth.facts` (the other
preset seams), `/status`'s `memberships` field, the `Membership` type, and every
part of `can()` / `AppAccess`. Vendo still holds no directory; the difference is
that it no longer ships a seam nobody asks a question through.
