---
"@vendoai/store": patch
"@vendoai/agents": patch
---

`s3()` is gone from `@vendoai/store` and from the `@vendoai/agents` root, along
with the `S3FilesOptions` type. The `files:` seam is unchanged: it takes a
`FilesAdapter` — three methods, `{ put, get, delete }` — exported from
`@vendoai/core` and the umbrella, and a host object in that slot has always won
over anything shipped.

Pre-1.0 hard cut, no shim. If you wired `files: s3({ … })` (or
`postgres(url, { blobs: s3({ … }) })`), pass your own `FilesAdapter` pointed at
the same bucket and prefix. Blobs already written are untouched: the keys are
minted by the store, never by the adapter, so the same objects read back with no
migration. The `aws4fetch` dependency drops with it, and the over-cap
store-backed file error now names `files:` and `FilesAdapter` instead of `s3()`.
