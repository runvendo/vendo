# Fixture provenance

Real `vendo-genui/v1` trees used by `measure-tokens.ts`. Two origins:

## `harvested/` — copied out of the legacy quarry (data only)

Legacy is a read-only quarry (see `CLAUDE.md`): copying tree DATA out of it is
fine; importing legacy CODE is forbidden and CI-enforced. These trees were
transcribed verbatim (field-for-field) from legacy test fixtures — the pre-v0
GenUI format is field-identical to the pinned `vendo-genui/v1` shape (same
`formatVersion`, same node/query/components structure), so they load unchanged.

| file | copied from |
| --- | --- |
| `harvested/stage-meshed.json` | `legacy/packages/vendo-stage/tests/browser/fixtures/host.ts` (~line 462) — prewired + generated + host siblings with a `$path` binding |
| `harvested/resolve-nested.json` | `legacy/packages/vendo-core/src/genui/resolve.test.ts` (~line 20) — Stack/Text/Card with a host node |
| `harvested/dag-shared.json` | `legacy/packages/vendo-core/src/genui/resolve.test.ts` (~line 144) — a shared child (DAG), the case a nesting DSL cannot encode losslessly |

These are small (hand-built unit-test inputs). They anchor the "tiny tree" end
of the measurement, where fixed per-document overhead dominates.

## `generated/` — fresh trees from the real model

Produced by `pnpm --filter @vendoai/spike-compact-tree generate:fixtures`
(`src/generate-fixtures.ts`), which prompts `claude-sonnet-5` with the
`vendo-genui/v1` spec + the Cadence-style generative-UI system prompt (the same
shape `legacy/apps/demo-accounting/src/vendo/agent.ts` uses in production) and a
realistic host-app request, then validates the output with
`@vendoai/core.validateTree` before saving. Each file carries a `_provenance`
key recording the request and the model. These are the realistic
medium/large trees that the token-savings claim actually rests on.
