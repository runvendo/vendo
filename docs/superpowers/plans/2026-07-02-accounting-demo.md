# Cadence Accounting Demo Implementation Plan

> **For agentic workers:** Execute with superpowers:executing-plans (inline). Steps use checkbox (`- [ ]`) syntax for tracking. Per Yousef's preference this plan is high-level: goals, steps, and decisions — no code.

**Goal:** Build `apps/demo-accounting` — Cadence, a production-quality mock accounting practice-management platform with a REST API + OpenAPI spec, per `docs/superpowers/specs/2026-07-02-accounting-demo-design.md`.

**Architecture:** Next.js 16 App Router app mirroring demo-bank. In-memory deterministic store behind pure server modules; API route handlers wrap the store; UI reads/writes through the API via SWR. Checked-in `openapi.json` is the future Flowlet seam.

**Tech stack:** Next.js 16, React 19, Tailwind 4, lucide-react, framer-motion, SWR, Vitest.

---

### Task 1: App scaffold
- [ ] Create `apps/demo-accounting` (package.json, tsconfig, next/postcss/eslint/vitest configs) modeled on demo-bank, minus Flowlet/AI dependencies.
- [ ] Add root script `demo:accounting`; confirm turbo picks the app up.
- [ ] Verify: dev server boots, typecheck passes.
- [ ] Commit.

### Task 2: Domain types, seed, and store (TDD)
- [ ] Define domain types (Client, DocumentRequest with status lifecycle, Message, ActivityEvent, Staff).
- [ ] Tests first: seed determinism (same anchor → same data), opening-state invariants (12 clients, exactly 8 missing documents, named spec clients present, deadlines relative to anchor).
- [ ] Implement seed + module-singleton store with reset helper.
- [ ] Tests for store transitions: receive → needs_review → verified; reject returns to missing with note; derived dashboard metrics update.
- [ ] Commit.

### Task 3: API route handlers + OpenAPI (TDD)
- [ ] Tests first for handler behavior: dashboard metrics, client list/filter/search, client 404s, document status transitions incl. invalid transition 400s, message post/list, deadlines, activity, demo reset, simulate-upload (correct and wrong-document variants).
- [ ] Implement route handlers under `src/app/api/*` wrapping the store; JSON errors with proper codes.
- [ ] Write `openapi.json` at the app root covering every endpoint (ENG-202-compatible shape, like demo-bank's).
- [ ] Commit.

### Task 4: Brand + app shell
- [ ] Cadence SVG logotype/mark, favicon, Tailwind theme tokens (evergreen/teal + warm neutrals), typography.
- [ ] Shared shell: sidebar nav (all destinations), top bar (search, firm, Maya Alvarez persona), layout, loading/empty-state primitives.
- [ ] Verify in browser; screenshot.
- [ ] Commit.

### Task 5: Dashboard page
- [ ] Stats row (clients missing docs, docs outstanding, docs received progress), tax-deadline countdown, upcoming-deadlines strip, recent-activity feed — all from the API.
- [ ] Verify in browser; screenshot.
- [ ] Commit.

### Task 6: Client list page
- [ ] Searchable/filterable table: business, entity type, documents progress ("3 of 6 received"), deadline, assignee, status; row click → detail.
- [ ] Verify in browser; screenshot.
- [ ] Commit.

### Task 7: Client detail page
- [ ] Document checklist with per-item status/actions (verify, reject with reason), message thread with composer (sends as firm), client info panel, per-client activity.
- [ ] Verify in browser incl. a full lifecycle interaction; screenshot.
- [ ] Commit.

### Task 8: Stub pages + demo control page
- [ ] Polished one-screen stubs: Work, Calendar, Inbox, Team, Settings, Integrations (Gmail/Drive/SharePoint/QuickBooks tiles, "Available" state).
- [ ] Hidden `/demo` control page: reset button, simulate-upload controls (client picker, correct/wrong document).
- [ ] Verify in browser; screenshots.
- [ ] Commit.

### Task 9: End-to-end verification + PR
- [ ] Full pass: `pnpm typecheck`, `pnpm lint`, `pnpm test` (repo-wide), fresh dev-server boot.
- [ ] Browser walkthrough of the demo choreography: reset → dashboard shows 8 missing → simulate wrong upload → reject visible → simulate correct uploads → counter ticks down.
- [ ] Screenshots of every page; open PR with screenshots (do not merge).
- [ ] Update Orca worktree comment.
