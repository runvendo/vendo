# Vercel AI SDK + Mastra connector launch: docs polish, graphic, X post

Date: 2026-07-23
Status: approved

## Goal

Announce the existing-agents connectors (Vercel AI SDK and Mastra tool packs)
on X. Before the post goes out, the three docs pages it links to must read as
pristine and easy. Deliverables: one docs-polish PR, one branded graphic, one
drafted X post (Yousef posts it himself).

## Deliverable 1: docs polish PR

Pages: `docs-site/existing-agents/index.mdx`, `ai-sdk.mdx`, `mastra.mdx`.
Polish only — no structural rework, no meaning changes.

- Compress each quickstart's "Try it" Warning (~20 lines) to ~5 lines. Keep
  the two facts that bite: the agent's own loop keeps its own model key, and
  Vendo's internal builds ride an explicit provider key unless
  `VENDO_DEV_CREDENTIAL=vendo-cloud`; `npx vendo login` mints a free dev key.
  Everything else defers to the dev-mode credential ladder page.
- State the principal-mismatch caveat once per quickstart, as one tight Note,
  instead of twice at length. Keep the symptom ("infinite pending skeleton").
- Tighten the step-1 "lift the composition into a shared module" prose
  without losing correctness.
- Add official logos: Vercel triangle and Mastra mark as SVG icons on the
  overview's two quickstart cards and as page icons on each quickstart.
- First mention on the AI SDK page reads "Vercel's AI SDK" so the docs match
  the post; page title stays "Quickstart: AI SDK".

Verification: local Mintlify render, browser screenshots in the PR (repo
rule for UI-affecting changes), `pnpm build && pnpm test && pnpm typecheck &&
pnpm lint` green.

## Deliverable 2: graphic

1200x675 code card in the Vendo brand system (porcelain/ink/ultramarine).
Content: the real one-spread integration snippet trimmed to ~8 lines, a
Vendo x Vercel x Mastra logo row, one tagline. Built as self-contained HTML,
rendered to PNG via Playwright, iterated visually. Official brand marks only.

## Deliverable 3: X post

Single post in Yousef's voice (write-as-me): hook, "keep your agent, three
steps" pitch, docs link, graphic attached. Draft only — Yousef posts it.

## Sequencing

Docs PR merges and docs.vendo.run redeploys before the post goes out, so the
link lands on the polished pages. Graphic and post draft can proceed in
parallel with PR review.

## Out of scope

Restructuring the quickstarts, code/behavior changes to the connectors,
vendo-web changes, posting to X on Yousef's behalf.
