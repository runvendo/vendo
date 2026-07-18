# Lane C: Playground Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npx vendo playground` — a local page that renders every shipped Vendo surface against scripted (fake) data, so a host developer sees every state without a model key, a database, or real wiring.

**Architecture:** A new CLI command in the umbrella package that serves a small self-contained React page bundled at vendo build time. The page mounts the chrome surfaces inside a `VendoProvider` whose transport is the existing scripted transport (`packages/ui/src/hooks/scripted-transport.ts` — the director-mode seam), driven by scenario fixtures. No network beyond localhost, no host app required.

**Source of truth:** `docs/brainstorms/ui-usage-dx.md` (§8 Playground). Read it first.

**Hard boundaries:** No new runtime dependencies in `@vendoai/ui`. The playground must not require the host's Next.js app or any credentials. Never commit to main; open a PR from this lane's branch.

---

### Task 1: Command skeleton

**Files:** create `packages/vendo/src/cli/playground.ts` (+ test), register in `packages/vendo/src/cli/framework.ts` following the existing command pattern (see `doctor.ts` for the shape).

- [ ] `vendo playground` starts a localhost server on a free port, prints the URL, opens the browser (same consent/pattern init uses for opening the app); `--port` and `--no-open` flags
- [ ] TDD the command wiring (registered, help text, port handling)

### Task 2: The playground page

**Files:** a small app under `packages/vendo/src/cli/playground/` (page source + build step producing a bundled asset the CLI serves; follow however the package currently builds/ships static assets, adding the minimal build wiring if none exists).

Surfaces and states to cover (a left nav of scenarios, each rendering the real chrome component):

- Overlay: closed-with-launcher, open mid-conversation, streaming turn
- Thread: streaming text, generated view arriving, approval parked in-turn, connect card
- Approval flow: pending → approved → resumed
- Slot: empty ghost, filled with a pinned view, broken view falling back to original children
- Activities: pending approvals + activity feed, and its empty state (skip gracefully if Lane B hasn't merged yet — add it when rebasing)
- Page: the full workspace console with fixture threads/apps
- Mobile: at least one scenario at a phone viewport

- [ ] Build scenario fixtures as scripted-transport scripts + static wire payloads (reuse/extend what the director-mode fixtures already provide rather than inventing a new fixture format)
- [ ] Wire the scenario nav; each scenario is one URL (hash or query) so specific states are linkable
- [ ] Browser-verify every scenario renders; screenshots of each in the PR

### Task 3: Polish + finish

- [ ] `vendo playground` mentioned in `docs/quickstart.md` (one line, after the init flow)
- [ ] Full gates green: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`
- [ ] PR with per-scenario screenshots; signal `needs-review` then `triage-complete` via worktree comment
