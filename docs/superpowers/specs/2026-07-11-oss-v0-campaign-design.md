# OSS Full-Stack v0 Campaign Design

Date: 2026-07-11
Source of truth: Notion page "Open-Source Full Stack Agentic Interface" (398efc48a641805c91dec9ec8289e3bf). The page is the spec; existing code proves nothing.

## Goal

The repo becomes the page for the v0 cut: skeleton blocks plus all four flagships, each rebuilt contracts-first from the page, with no old assumptions carried over.

## v0 block cut

In: core, agent, ui, store, umbrella (@vendoai/vendo) plus flagships apps, actions, guard, automations.

Deferred entirely, no stub packages: meter, memory, knowledge, mcp door, evals.

## Target package map (old to new)

- vendo-core: becomes core (contracts only; app format spec moves under apps)
- vendo-runtime, vendo-server: split into agent (the loop), actions (all tools: extraction, host API, Composio and MCP client, actAs), guard (policy, approvals, audit, Vendo Auto), apps (artifact, sandbox runtime, generation engine)
- vendo-shell, vendo-components, vendo-stage, vendo-react, vendo-client: become ui (headless hooks, chrome, all surfaces including voice)
- vendo-store: stays store
- automations code: becomes automations, rebuilt as "an app with a trigger"
- vendo-cli plus umbrella: @vendoai/vendo umbrella and DX (init, doctor, per the locked DX design)
- vendo-telemetry: stays as-is (orthogonal)

## v0 flagship deltas (all in scope)

1. App ladder and sandbox seam: app manifest, UI to state to server code to own data to files escalation, BYO sandbox adapter (e2b, Modal)
2. actAs seam: one host-implemented actAs(principal, grant) function for away execution
3. Vendo Auto: guard's LLM judge mode (run, ask, block per call), deterministic breakers as backstop
4. Sharing vs publishing plus org overlay: snapshot sharing, org registry with capability-aware updates, versioned org overlay

## Waves

Each wave is one or more PRs, dual-reviewed, merged only by Yousef.

1. Purge: one pass deleting everything from the old version that the v0 target obsoletes: dead code, stale experiments, flowlet-era leftovers, live code whose replacement is already decided by the page. Demos and corpus may go temporarily red; they come back by the end of the campaign.
2. Contracts: every block's public API written fresh from the page (types, one-job boundary, layered dependency rule core to apps to automations, enforced by the dependency-guard CI gate) plus the app format spec v0. Yousef reviews before any porting.
3. Skeleton blocks: core, store, agent, ui built in parallel worktrees against frozen contracts. Old code ports only where it satisfies a contract.
4. Actions plus guard, in parallel: actions (unified tool shape, actAs), guard (choke point, Vendo Auto, queryable audit).
5. Apps: artifact, escalation ladder, sandbox adapter, sharing vs publishing, org overlay. Likely two PRs (artifact and runtime, then sharing and publishing and overlay).
6. Automations: rebuilt on apps. Three trigger kinds, deterministic plus agentic run models, away identity via actAs.
7. Composition: umbrella and DX rebuilt on new blocks, Maple and Cadence migrated and browser-verified, corpus suite adapted and green, residue sweep, publish the next version train, clean-room install verified.

## Acceptance bar

- Demos (Maple, Cadence) rebuilt on the new blocks and browser-verified
- Corpus suite green (adapted to new package names)
- npm install @vendoai/vendo plus npx vendo init works clean-room
- pnpm build, test, typecheck, lint green

## Execution model

This session orchestrates. Block waves run as parallel Orca worktrees with codex executors. No merges and no UI decisions without Yousef. The contracts wave, especially the apps contract, is an explicit Yousef approval gate.
