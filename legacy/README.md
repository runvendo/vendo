# legacy/ — the wave-3 quarry (read-only)

The pre-v0 packages and demo apps, moved out of the active pnpm workspace when
wave 3 of the v0 campaign started building the new blocks against the frozen
contracts in `docs/contracts/`.

Rules (00-overview.md, "Wave 3+ ground rules"):

- **Read-only quarry.** Nothing in here is built, tested, or published. Code
  transplants into a new block only when it satisfies the frozen contract, and
  arrives in the diff as an addition.
- **New packages never import from here** — enforced by
  `scripts/dependency-guard.mjs` (runs in `pnpm lint`).
- **Deleted wave by wave.** Each directory is removed in the wave its
  replacement goes green; the quarry shrinks to zero by wave 7.

The demo apps (`legacy/apps/`) and the corpus harness (`corpus/`) are
temporarily red by design; they return against the new packages in wave 7.
