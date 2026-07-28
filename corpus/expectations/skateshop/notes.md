# skateshop labeling notes

## `ai-expected.json` risk rows verified and LEFT unchanged

Both rows below are repeatedly flagged as mislabeled by extraction runs. They
were checked against the pinned source and are CORRECT as labeled; a model
disagreeing with them is a bug report about the model, not a reason to relabel.

- `GET /api/revalidate` stays `read`. The handler's entire body is a cache
  invalidation, which the labeling rule explicitly does not count as a
  mutation. `src/app/api/revalidate/route.ts:9`: `revalidatePath("/")` — and
  lines 5-7 gate the route to `NODE_ENV === "development"` anyway.
- `GET /api/uploadthing` stays as labeled. `src/app/api/uploadthing/route.ts:6`
  is `export const { GET, POST } = createRouteHandler({` — an SDK catch-all
  where GET serves router config and POST carries uploads. Per-method behaviour
  lives inside the `uploadthing` package, so this repo's source cannot settle
  the grade.
