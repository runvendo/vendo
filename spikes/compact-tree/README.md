# @vendoai/spike-compact-tree

**SPIKE — not shipped.** A throwaway investigation into whether a token-compact
wire profile for the pinned `vendo-genui/v1` tree (the app-format spec §7
"named-now, designed-later" commitment) actually pays off for our tree shape.

Nothing here changes the pinned wire format or registers a new format in
`@vendoai/core`. Everything lives under `spikes/compact-tree/`. Output is
evidence + a recommendation for Yousef — see **[DESIGN.md](./DESIGN.md)**.

## What's inside

- `src/canonicalize.ts` — the explicit canonical form both profiles round-trip to.
- `src/profile-cjt.ts` — **Candidate A** (CJT): conservative JSON — single-char
  keys, a component intern table, positional node tuples.
- `src/profile-vtl.ts` — **Candidate B** (VTL): aggressive line-oriented DSL.
- `src/arbitrary.ts` + `src/roundtrip.test.ts` — fast-check property tests proving
  `decode(encode(t))` deep-equals `canonicalize(t)` across the format's range,
  plus hand-built edge cases (DAG/cycle/dangling, empty-vs-absent, near the
  5000-node cap).
- `fixtures/` — real `vendo-genui/v1` trees (harvested from the legacy quarry +
  fresh model output). See `fixtures/PROVENANCE.md`.
- `results/latency.json` — raw per-trial records from the latest live
  latency/validity run (every attempted trial retained, invalid ones included).
- `src/measure-tokens.ts`, `src/generate-fixtures.ts`, `src/generate-latency.ts`
  — key-gated measurement scripts (never part of `pnpm test`).

## Run the tests (root gates)

The property tests run under the normal root gates:

```sh
pnpm --filter @vendoai/spike-compact-tree test
# or, from the repo root, the whole train:
pnpm build && pnpm test && pnpm typecheck && pnpm lint
```

## Run the measurement scripts (key-gated, manual)

These call the Anthropic API and are **not** part of `pnpm test`. Build first,
then source the key (never print or commit it):

```sh
pnpm --filter @vendoai/spike-compact-tree build
source /Users/yousefh/orca/workspaces/flowlet/.env   # sets ANTHROPIC_API_KEY

# 1. Token savings on real trees (count-tokens API + byte counts):
pnpm --filter @vendoai/spike-compact-tree measure:tokens

# 2. (Re)generate the fresh fixtures under fixtures/generated/:
pnpm --filter @vendoai/spike-compact-tree generate:fixtures

# 3. Live latency + emission-validity trials:
pnpm --filter @vendoai/spike-compact-tree measure:latency
```

Env knobs for `measure:latency`: `MODELS` (comma list, default
`claude-sonnet-5,claude-haiku-4-5`), `TRIALS` (per arm, default 5), `REQUESTS`
(comma list of UI-request ids). `COUNT_MODEL` / `GEN_MODEL` override the model
used for token counting / generation.
