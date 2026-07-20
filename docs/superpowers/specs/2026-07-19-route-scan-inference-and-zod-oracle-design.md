# Route-scan schema inference + zod oracle tests — design

Date: 2026-07-19
Status: approved (Yousef, this session)
Scope: `packages/actions` (sync extractors); two PRs, oracle first.

## Problem

Route-scan discovers Next.js route handlers but emits permissive input
schemas (`additionalProperties: true`, no properties). Agents facing those
tools must guess what to send. Meanwhile the static zod reader
(`zodFromExpression` in `sync/static-ts.ts`) — shared by the tRPC,
server-actions, and catalog-scan extractors — has no direct test suite; it is
covered only indirectly through extractor fixtures.

## Goals / success criteria

1. Route-bound tools get real input schemas wherever the handler's input
   shape is statically knowable (zod validation in the handler, or
   TypeScript types the checker can resolve).
2. The zod reader gains an automated answer key: every supported pattern is
   differential-tested against real zod + `zod-to-json-schema`.
3. Zero behavior change where inference finds nothing: those tools' entries
   in `tools.json` stay byte-identical.

## Decisions (locked)

- Both collectors (zod-in-handler and checker inference) ship in one design,
  as PR 2. Oracle tests ship first as PR 1.
- Input coverage: request body + query string. Headers are out of scope
  (rare as agent-suppliable input, usually auth).
- Architecture: extend route-scan in place (approach A) — no separate
  enrichment pass, no full-program rewrite of discovery.
- Oracle tests are table-driven (approach A) — no property-based fuzzing in
  this iteration.

## PR 1 — zod oracle test suite

New test file in `@vendoai/actions` beside the existing sync tests. Each
table row holds a zod expression as source text and runs it two ways:

- through the static reader (`zodFromExpression`), which pattern-matches the
  text without executing it;
- through real zod + `zod-to-json-schema` (the oracle), both added as
  devDependencies only — never shipped in the published package.

A small normalizer strips the oracle's cosmetic output differences
(`$schema` key and similar) so only genuine disagreements fail the test.
Rows where the static reader intentionally fails closed to a permissive
schema (unrecognized validators such as `.refine`) are marked in the table;
for those the test asserts the fallback fired rather than schema equality.
The table doubles as the catalog of exactly which zod patterns the reader
supports.

## PR 2 — route-scan inference

Route-scan's discovery logic is untouched. At tool-emission time each
handler is offered to collectors, first answer wins for the body:

1. **Zod collector** — detect validator-parse-of-request-body patterns
   inside the handler, resolve the validator expression across files (same
   resolution machinery the tRPC extractor uses), and interpret it with
   `zodFromExpression` (hardened by PR 1).
2. **Checker collector** — one TypeScript program per repo, host-resolved
   compiler, built lazily the first time any handler needs it and shared
   across all route files. Ask the checker for the parsed body's type
   (annotation, cast, or inference) and convert a supported subset to JSON
   Schema: primitives, literal unions, arrays, nested objects, optionality.
   Types outside the subset fail closed to the permissive schema with a note
   on the tool.

The **query collector** runs additively in both cases: literal
`searchParams.get`/`getAll` reads become optional string-typed properties
merged into the body result (or into the permissive schema when no body
shape was found).

Names, bindings, risk grading, and shadow-filtering are unchanged.

## Fail-closed rules

- Inference only narrows the blank form. It never invents endpoints, never
  changes risk, and marks a property required only on explicit evidence
  (zod non-optional, or non-optional TS property).
- Host TypeScript unresolvable (JS-only repo): warning in the sync report,
  today's output.
- Any collector error: caught, warning, today's output.
- A handler with no detectable input reads keeps the permissive schema —
  absence of reads is not proof of absence of input (the request may be
  forwarded, e.g. demo-bank's voice proxy route).

## Testing & verification

- PR 1 is self-verifying (the suite is the deliverable).
- PR 2: fixture tests in the existing route-scan test style covering
  zod-validated handler, typed-cast handler, annotated-variable handler,
  query reads, mixed body+query, unsupported type (fail-closed), JS-only
  repo, and the no-input proxy handler.
- Real-world check: re-run sync on demo-bank and demo-accounting and review
  the tools.json diff; run the corpus Layer-2 sweep. Corpus expectation
  files that pin route-tool schemas are updated in the same PR (expected
  drift, not failure).
- Repo gate before each PR: `pnpm build && pnpm test && pnpm typecheck &&
  pnpm lint`.

## Out of scope

Header inference, response schemas, risk-grade changes, Express scanning,
OWASP Noir integration, traffic-capture enrichment, property-based fuzzing
of the oracle table.
