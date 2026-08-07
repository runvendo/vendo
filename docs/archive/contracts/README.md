# Archived: the frozen-contract system (retired 2026-07-17)

These files were v0/v1's living package contracts. Yousef retired the system
during the v2 overhaul: maintaining a prose mirror of the code was double
bookkeeping — the drift findings in review after review proved the point.

The behavior contract is now, and was always really:

- the exported **types and zod schemas** of each package,
- the **test suites** (conformance, wire parity, package tests) that pin behavior,
- `scripts/dependency-guard.mjs` for layering.

Per-project **design specs** in `docs/superpowers/specs/` remain the decision
records for new work (written once, read while building, not maintained as law).

These files are kept for historical reference only. Do not update them.
