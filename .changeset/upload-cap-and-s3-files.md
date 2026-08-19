---
"@vendoai/vendo": minor
"@vendoai/store": minor
---

The upload door's 5 MiB cap is a knob, and there is a bucket to raise it into.

`createVendo({ uploadMaxBytes })` sets what one browser upload may carry through
`POST /files`, defaulting to the `UPLOAD_MAX_BYTES` that used to be the only
answer. It is still a DOOR cap and not a storage cap: `vendo.putUserFile` is a
trusted server caller, bounded by whatever backs `files:` instead. The knob is
checked when you compose rather than when a user uploads: anything that is not a
positive integer refuses `createVendo` and names the value, `NaN` and `Infinity`
included — both are numbers the types allow, and both would make the doors' size
comparison false forever, deleting the cap instead of moving it.

Raising it is only half a fix, so the refusal now says the other half. Past
5 MiB with no `files:` adapter an upload clears the door and dies at the store's
own blob cap, so the over-cap error names the knob AND the backing the bytes
would have landed in — the store and the cap that really bounds it, or the
`FilesAdapter` the host wired.

`s3Files({ endpoint, bucket, credentials })` is that adapter, ready-made, for
any bucket that speaks S3: AWS, Cloudflare R2, Supabase Storage, MinIO. SigV4
over WebCrypto via `aws4fetch`, path-style, so it runs on an edge target too;
`region` defaults to `"auto"` (what R2 requires, what MinIO ignores) and
`prefix` lets one bucket hold several deployments. It reads no environment of
its own — which credentials reach it stays the composition seam's question —
and resolves nothing until its first call, so `createVendo` stays I/O-free at
module init.
