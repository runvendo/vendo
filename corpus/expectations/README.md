# Corpus Expectations Labeling Guide

Layer 2 compares `vendo init` output against hand-labeled ground truth in:

```text
corpus/expectations/<repo>/expected.json
corpus/expectations/<repo>/baseline.json
```

Labels come from the pinned repo source only. Do not copy values from `.vendo/`
output, because that would bake current extractor behavior into the truth set.

## Scope

A 2026-07-20 Noir cross-check audit (independent HTTP-endpoint enumeration
against six repos' pinned clones) found two classes of truth-set error;
these rules exist to stop them from recurring.

- **Tools are labeled only for the detector's intended surface**: app-router
  route handlers under `/api` (or an `(api)` route group) and Pages Router
  handlers under `pages/api`, matching `appRoutePath`/`pagesRoutePath` in
  `packages/actions/src/sync/route-scan.ts`. Route handlers that live
  elsewhere are out of scope by design and must not be labeled — for example
  umami's tracking-pixel and redirect collect endpoints at
  `src/app/(collect)/p/[slug]/route.ts` and `src/app/(collect)/q/[slug]/route.ts`
  are real `GET` handlers but sit outside `/api`, so they are intentionally
  absent from `expected.json`, not a labeling miss.
- **Method evidence must come from the handler's actual method exports or
  `req.method` branches, never from `Allow` response headers on 405
  responses.** papermark's pages/api handlers set an `Allow` header on their
  405 branch that does not always match the method the handler actually
  implements (e.g. a POST-only handler 405ing with `Allow: GET, POST`); a
  labeling pass that trusted those headers produced four phantom tools —
  methods the source always rejects with 405. Read the `if (req.method ===
  ...)` branch (or the exported `GET`/`POST`/etc. functions) directly.
- **When sweeping a repo for labels, walk every `app/**/route.ts*` (and
  `pages/api/**`) file first, then apply the scope rule above.** Filtering to
  `**/api/**` before looking means out-of-scope route handlers are never
  seen at all, rather than seen and consciously excluded — that blind spot is
  exactly how umami's two collect endpoints were missed during the same
  audit.

## expected.json

```json
{
  "version": 1,
  "theme": {
    "background": "#ffffff",
    "surface": "#f5f7fa",
    "accent": "#0a7cff",
    "text": "#111418",
    "mutedText": "#5b6470",
    "radius": 8,
    "fontFamily": "Inter, sans-serif"
  },
  "tools": [
    { "name": "listInvoices", "method": "GET", "path": "/api/invoices", "readOrWrite": "write" },
    { "name": "createInvoice", "method": "POST", "path": "/api/invoices", "readOrWrite": "write" }
  ],
  "annotations": [
    { "name": "listInvoices", "mutating": true, "dangerous": false },
    { "name": "createInvoice", "mutating": true, "dangerous": false }
  ],
  "components": [
    {
      "name": "InvoiceBadge",
      "descriptionIncludes": ["invoice", "status"],
      "props": ["status"]
    }
  ]
}
```

## Theme

Use the seven rubric dimensions from the PR #63 theme-extractor evaluation:

- `background`
- `surface`
- `accent`
- `text`
- `mutedText`
- `radius`
- `fontFamily`

Read the app's source tokens, global CSS, Tailwind config, and font setup at
the pinned SHA. Record fully resolved primitive values, not CSS variables.
Normalize HSL, OKLCH, Tailwind palette classes, and rem radii to the schema's
primitive form (hex colors and pixel radii). For example `0.5rem` is `8`.
If a value is genuinely absent, label the default Vendo should choose and note
the uncertainty in the repo's labeling notes when Task 11 adds real labels.

Layer 2 scores each dimension as one point. Hex colors compare
case-insensitively. Radius `8` and `"8px"` are treated as equivalent.

## Tools

Derive the expected inventory from the app's source-owned API surface:

- Prefer OpenAPI or route metadata when present.
- Otherwise inspect Next.js route handlers, Pages API routes, or equivalent
  server route files at the pinned SHA.
- Follow simple source-owned wrappers and re-exports to the handler that owns
  the HTTP method checks. For framework handlers such as NextAuth or
  UploadThing, label the methods exported by that route file.
- Include only host-relative paths, with path params in the same template style
  Vendo should emit, for example `/api/invoices/{id}`.
- Use uppercase HTTP methods.
- `readOrWrite` is `read` for read-only operations, normally `GET`.
- `readOrWrite` is `write` for operations that create, update, delete, trigger,
  send, cancel, revoke, or otherwise change host state.
- Route-scan-derived tools are always labeled `write` even for `GET`, because
  route code can hide side effects behind read-shaped methods and Vendo must not
  auto-allow inferred route handlers. OpenAPI-derived tools may use `read` for
  spec-declared read-only operations.

Use deterministic lower-camel names so labels are not tied to one LLM run.
Expectation files omit the runtime `host_` provenance prefix; the scorer adds
it before comparison with v0 `ToolDescriptor.name` values:
prefix the lowercase HTTP method, drop the leading `api` path segment, and
PascalCase each remaining static or parameter segment. Examples:
`GET /api/invoices/{id}` becomes `getInvoicesId`, and
`POST /api/teams/{teamId}/invite` becomes `postTeamsTeamIdInvite`.

Layer 2 scores tools as precision and recall over the full
`{name, method, path, readOrWrite}` tuple.

## Annotations

Every expected tool needs a safety annotation. The label pair maps directly to
the v0 `ToolDescriptor.risk` union (`read`, `write`, `destructive`):

- Read-only tools: `{ "mutating": false, "dangerous": false }`.
- State-changing tools: `{ "mutating": true, "dangerous": false }`.
- Destructive or high-risk writes, such as delete, cancel, revoke, purge, reset,
  transfer, send, or close: `{ "mutating": true, "dangerous": true }`.
- Route-scan-derived tools are expected to set `mutating: true` regardless of
  HTTP method. LLM-assisted route descriptions never grant auto-allow.
Write safety is a hard check. If generated output marks any write-capable tool
as auto-allowed, Layer 2 fails regardless of the numeric score.

## Components

Use `components` for expected host component descriptors that `vendo init`
should expose. Label only reusable presentational components that can render
from JSON-serializable props without callbacks, hooks, data fetching, providers,
or `ReactNode` slots.

- `name` is the expected generated registry name.
- `descriptionIncludes` lists short lowercase facts that must appear in the
  generated descriptor description.
- `props` lists expected JSON prop names.

Leave `components` as an empty array when no host component label has been
derived yet.

## baseline.json

Baselines record the accepted Layer 2 score for a labeled repo:

```json
{
  "version": 1,
  "generatedAt": "2026-07-06T12:00:00.000Z",
  "score": { "passed": 10, "total": 10, "value": 1 }
}
```

The scorer flags a regression when a run scores below baseline. When a run
scores above baseline, it prints a replacement `baseline.json` candidate but
does not edit or commit it.

## ai-expected.json

Ground-truth labels for the AI extraction matrix (`pnpm corpus ai`). Entries
reuse the same binding identities as `expected.json` (method + path, tRPC
procedure, GraphQL operation, server-action module + export) and carry the
judgment the AI pass is scored on:

```json
{
  "version": 1,
  "tools": [
    { "name": "listInvoices", "method": "GET", "path": "/api/invoices", "risk": "read" },
    { "name": "deleteInvoice", "method": "DELETE", "path": "/api/invoices/{id}", "risk": "destructive", "critical": true },
    { "name": "webhook", "method": "POST", "path": "/api/webhooks", "risk": "write", "wake": false }
  ]
}
```

- `risk` is the correct semantic grade. The current files are derived
  mechanically: HTTP verbs are the read/write baseline (GET is `read`,
  everything else `write`) because several repos' `readOrWrite`/`mutating`
  labels blanket-mark GETs as writes (a Layer 2 fail-closed join artifact);
  the curated `dangerous` flags upgrade to `destructive`; non-HTTP bindings
  keep their hand labels. Replace individual entries with hand-verified
  grades as curation improves — hand labels always beat the derivation.
- `critical` marks tools that must carry a critical (irreversible) mark. It is
  a curator addition, never derived; the critical check only runs for repos
  that label at least one.
- `wake` matters only for statically-unclassifiable tools (emitted disabled).
  A disabled tool whose identity matches a labeled entry is expected to be
  woken at the labeled risk; set `wake: false` to pin one that must stay
  asleep. Labels whose identity was never extracted are a static-extraction
  recall problem (Layer 2's job) and are excluded from AI scoring.
