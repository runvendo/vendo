---
"@vendoai/core": patch
"@vendoai/store": patch
---

`appData` fences the owner, so a path-like subject can no longer read another
user's files.

The owner is the first path segment of every appData file key (`<owner>/<key>`),
and nothing checked it. `appId` was fenced against `":"` and `collection`
against `APP_DATA_COLLECTION_PATTERN`; the owner went in raw. So owner
`own_a/sub` reading `x.bin` read owner `own_a`'s file `sub/x.bin` — a silent
cross-user read for any host whose subject ids contain a slash, which
`org/user`, an email-derived id, or a URI-style OIDC subject all can.

`APP_DATA_OWNER_PATTERN` (`/^[^/]+$/`) is now enforced at the wire schema and at
the store composer, on every one of the eight verbs, with the `validation` code.
Deliberately **not** a slug grammar: a subject is the host's own user id in the
host's own spelling, so `auth0|64f…`, `user:with:colons` and
`person@example.com` all still pass. Only `/` is refused — and it is refused,
never rewritten, because a sanitised owner would land two different people in
one drawer.
