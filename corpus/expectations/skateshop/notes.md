# skateshop labeling notes

Pinned SHA e954d543.

## Curated `ai-expected.json` risk rows (hand-verified, FROZEN)

Read from the pinned source and independently confirmed by a second reviewer
given only the handler excerpt, the then-current label and the applicable rule.
Do not relabel these from model output.

- `POST /api/revalidate/{tag}` → `read` (was the mechanical `POST` → `write`).
  The whole body is a cache invalidation, which the labeling rule explicitly does
  not count as a mutation. `src/app/api/revalidate/[tag]/route.ts:20`:
  `  revalidateTag(tag)` — and lines 12-14 gate the route to 403 unless
  `env.NODE_ENV` is `"development"` anyway. This is the grade its
  `GET /api/revalidate` sibling already carried; the two rows disagreed only
  because one verb is `GET` and the other `POST`.

- `GET /api/uploadthing` → `write` (`POST` was already `write`), the catch-all
  graded at its worst reachable operation. `src/app/api/uploadthing/route.ts:6`:
  `export const { GET, POST } = createRouteHandler({` — one SDK handler pair for
  every action. The worst action is an upload, which creates a stored file object
  at the provider: `src/app/api/uploadthing/core.ts:12`:
  `  productImage: f({ image: { maxFileSize: "4MB", maxFileCount: 3 } })`.
  Nothing behind the URL deletes: the handler's complete action set lives in the
  pinned dependency (`uploadthing` `^6.13.2`, `package.json:104`) —
  `internal/types.d.ts:407`:
  `declare const VALID_ACTION_TYPES: readonly ["upload", "failure", "multipart-complete"];` —
  and `grep -rni "utapi\|deleteFiles\|deleteFile"` over `src/` returns nothing,
  so no path in this repo deletes an uploaded object. `write`, not `destructive`.

  Worth knowing for the description dimension rather than the risk one:
  `core.ts:34-42` persists NOTHING locally — `onUploadComplete` only
  `console.log`s (`:36`, `:38`) and returns `{ uploadedBy: metadata.userId }`.
  The stored state this row is graded on is the file at the provider, not a row
  in skateshop's own database.

## Rows verified and LEFT unchanged

- `GET /api/revalidate` stays `read`. The handler's entire body is a cache
  invalidation. `src/app/api/revalidate/route.ts:9`: `revalidatePath("/")` — and
  lines 5-7 gate the route to `NODE_ENV === "development"` anyway. This row is
  repeatedly flagged as mislabeled by extraction runs; it is CORRECT as labeled,
  and a model disagreeing with it is a bug report about the model, not a reason
  to relabel.
- `POST /api/uploadthing` stays `write` — the same catch-all grade as its `GET`
  twin above.
