# Demo refresh (local pass) — implementation plan

> Executes the demo-facing parts of `docs/superpowers/specs/2026-07-22-vendo-models-demo-refresh-design.md`.
> Everything stays LOCAL on `yousefh409/demo-2` — commits only, no pushes, no PRs.
> Deploy, nightly, gateway ids, and landing the open v4 PRs are later phases.

**Goal:** Both demos feel native (visible branded agent, contextual entry
points, real microapps living in product pages), run the newest generation
stack, and carry the scenario chip ladder — ready for local iteration.

**Verification bar:** every UI change is verified in a real browser with
screenshots; `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green at
the end.

## Group A — runtime enablers (this session, inline)

1. Thread `apps.pipeline` through `createVendo` so hosts can enable the v4
   pipeline flags (promptRewrite, structuredRepair, regionParallel, endPass).
   Test at the compose seam.
2. Response discipline in the runtime agent prompt: after rendering an app
   embed, never restate its data as a markdown table; no emoji unless the
   host's voice uses them; no narration about the UI mechanics. Anchor with a
   prompt-content test alongside existing agent prompt tests.
3. Labeled scenario chips: extend the thread/greeting suggestions surface so a
   chip carries {label, prompt} (the known packages/ui follow-up). Keep the
   existing unlabeled form working.

## Group B — Maple (subagent, after A)

4. `src/vendo/server.ts` rewire: drop explicit main/paint models and
   `createStore` (the ladder + local default store take over — locally this
   resolves ANTHROPIC_API_KEY; deployed it resolves VENDO_API_KEY). Judge on
   unconditionally via `vendoAutoJudge` + `devModel()` (switches to
   `vendoModel("vendo-judge")` when the model-family lane merges). KEEP the
   conditional Composio connector (it powers the integration beat locally and
   deployed services simply omit the key). Enable the full v4 pipeline set.
   Known deliberate regression until the model lane merges: paint rides the
   main model.
5. Launcher on and branded: replace `launcher="none"` with a Maple-branded
   launcher (label + mark). ⌘K stays. Sidebar keeps "Ask Maple" but the
   launcher is the front door.
6. Contextual triggers: "Ask Maple" affordances on transaction rows/detail and
   Insights, prefilled prompt + record context, never auto-sent.
7. Insights gets a labeled empty VendoSlot (ghost + suggestions) so apps can
   be pinned into the page; Home slot stays.
8. Scenario chips (from the spec ladder): where-did-money-go, move-to-savings
   (guard approval), email-me-weekly (integration + automation), pin-to-home.
9. `serverExternalPackages` PGlite fix in next.config.
10. All UI verified in the browser with screenshots before the group closes.

## Group C — Cadence (subagent, after B, mirrors its patterns)

11. Same server rewire (judge via devModel already half-wired; make it
    unconditional), same pipeline flags, PGlite fix.
12. Branded launcher on; triggers on invoices/clients; a labeled empty slot on
    the dashboard; the Cadence scenario chips (overdue invoices, reminder
    emails with per-send approvals, calendar automation, pin report).
13. Browser-verified with screenshots.

## Group D — closing pass (this session)

14. Full gate run (build/test/typecheck/lint).
15. Live walkthrough of both demos: run each scenario chip end to end; judge
    the generated microapps visually; iterate on design-rules/chips until the
    output is genuinely solid and decently complicated (multi-widget, interactive
    microapps — not a lone chart). Screenshots saved for comparison.
16. Update demo READMEs/docs to match the new surfaces.

## Decisions locked (don't relitigate during execution)

- Overlay stays a centered modal; no side-panel work.
- Chips are visible; no hidden palette.
- No client-side vendo-* mapping anywhere.
- Local only: no pushes, no PRs, no deploys in this pass.

## Amendment (2026-07-23, mid-execution pivot)

Yousef repriorized: a 100% scripted demo flow (pre-created microapps, zero AI
calls, real approval/automation/activity plumbing) shipped first and DEPLOYED to
demos.vendo.run/maple via the demo-creator pipeline (#316 merged locally for the
tooling). Groups C (Cadence) and parts of D are deferred; the real-AI
quality/latency work moved to a parallel worktree lane. The overlay landing
composer moved to the panel bottom and Maple's hardcoded glance card became the
real `home-hero` VendoSlot (50/50 with the balance card) as part of this pivot.
