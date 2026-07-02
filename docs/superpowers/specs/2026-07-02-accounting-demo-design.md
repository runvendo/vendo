# Cadence — Accounting Practice-Management Demo App

**Date:** 2026-07-02
**Status:** Approved by Yousef (design sections approved as-is; full autonomous build authorized: "just do whatever you recommend, I want to come back to it ready. Make it look sleek and modern.")
**Source spec:** Notion "Demo Video Specs" (Vendo Demo Build Spec: Accounting Practice-Management Tool)

## Goal

Build a production-quality mock of an accounting-firm practice-management platform (comps: Financial Cents, Canopy, Karbon, Cone) to serve as the host product for the Flowlet/Vendo demo video. The app is the software an accounting *firm* uses to run client operations — onboarding, document collection, deadlines, tasks, client comms. It is explicitly **not** QuickBooks.

Flowlet is **not** integrated in this phase. The app must expose its API (REST + `openapi.json`) so the agent can be wired in later via the ENG-202 host-tools path.

## Personas & fiction

- **Vendor:** Cadence (the mock SaaS company; who Vendo would sell to). Brand shown throughout.
- **Tenant firm:** Hartwell & Associates — a small bookkeeping/accounting firm (3–15 staff).
- **Signed-in user:** Maya Alvarez, Account Manager. Non-technical; drowning in document chasing during tax season. No real auth — signed-in chrome only.
- **Firm's clients:** small businesses/individuals (Rivera Landscaping LLC, Chen Consulting, Delgado Restaurant Group, etc.) who get chased for tax documents.

## Decisions (locked during brainstorm)

1. **Page scope:** core demo screens built fully; remaining nav items are polished stubs (no dead links, no "lorem" filler).
2. **Data layer:** in-memory module-singleton store, deterministic seed anchored to the current date (demo-bank pattern), plus `POST /api/demo/reset`.
3. **Brand:** Cadence.
4. **Structure:** new monorepo app `apps/demo-accounting` mirroring demo-bank (Next.js 16 App Router, React 19, Tailwind 4, lucide-react). Root script `pnpm demo:accounting`. No Infisical (no secrets yet).

## Visual direction

Sleek and modern, production-grade: Linear/Karbon-class polish. Crisp typography, generous whitespace, restrained color, subtle borders and shadows, quiet motion (framer-motion only where it helps). No emojis anywhere; lucide icons plus a real SVG Cadence logotype/mark and favicon. Palette: deep evergreen/teal primary with warm neutrals; status colors reserved for document/deadline state. Light theme.

## Data model

All types in a shared `server/types.ts`; seed in `server/seed.ts`; singleton store in `server/store.ts`.

- **Client:** id, business name, entity type (S-corp, sole prop, partnership, C-corp, individual), contact (name, email), assignee (staff), filing deadline (seeded relative to today so the countdown is urgent), status derived from documents.
- **DocumentRequest:** per client — kind (W-2, 1099-NEC, bank statements, prior-year return, payroll summary, receipts…), status lifecycle `missing → received → needs_review → verified` (filed) or `rejected` (wrong document, returns to missing with a note), optional uploaded-file metadata (name, uploadedAt).
- **Message:** per client thread — direction (firm→client / client→firm), author, body, timestamp.
- **ActivityEvent:** firm-wide feed (upload received, document verified/rejected, message sent, deadline approaching).
- **Staff:** small fixed roster for assignees/avatars.
- Dashboard metrics are derived from the store, never stored.

**Seed state (opening state of the demo):** ~12 clients; exactly **8 clients missing documents**; a mix of partially-complete checklists ("3 of 6 received"); message history that feels lived-in; nearest filing deadline a few weeks out.

## Pages

Fully built:
- **`/` Dashboard:** "8 clients missing documents" stat, tax-deadline countdown, docs-received progress, upcoming deadlines strip, recent activity feed.
- **`/clients` Client list:** searchable/filterable table — business, entity type, documents column ("3 of 6 received" with progress), deadline, assignee, status.
- **`/clients/[id]` Client detail:** document checklist with per-item status and actions, message thread (composer sends as firm), client info panel, per-client activity.

Polished stubs (real page shells with honest empty/preview states, one screen each): **Work** (tasks), **Calendar** (deadlines), **Inbox** (document inbox), **Team**, **Settings**, **Integrations** (tiles for Gmail, Google Drive, SharePoint, QuickBooks — "Available" state; visually ready to support Beat 3's "connected" moment later).

Shared shell: left sidebar nav with Cadence mark, top bar with search, firm name, persona avatar. Loading and empty states throughout.

## API (the Flowlet seam)

REST route handlers under `src/app/api/*`, described by a checked-in `openapi.json` at the app root (same artifact the ENG-202 OpenAPI→client-executed-tools path consumes). JSON errors with proper status codes (400/404).

- `GET /api/dashboard` — metrics (clients missing docs, docs outstanding, nearest deadline…)
- `GET /api/clients` (filter: missing-docs, search), `GET /api/clients/{id}`
- `GET /api/clients/{id}/documents`, `POST /api/clients/{id}/documents/{docId}/status` — transition: receive, verify (file), reject-with-reason
- `GET /api/clients/{id}/messages`, `POST /api/clients/{id}/messages` — send as firm (what the agent will use to chase clients)
- `GET /api/deadlines`, `GET /api/activity`
- **Demo choreography:** `POST /api/demo/reset` (restore seed between takes); `POST /api/demo/simulate/upload` (a named client "uploads" a file — correct or deliberately wrong, e.g. personal bank statement instead of business — powering the wrong-document catch). Driven from a hidden `/demo` control page.

UI reads/writes through the same API (SWR), so agent-driven mutations later will be visible live in the UI with polling/refresh.

## Testing & verification

- Vitest unit tests for seed determinism, store transitions (document lifecycle, reset), and API handlers (demo-bank pattern).
- `pnpm typecheck` / `pnpm lint` via turbo.
- Real-browser verification with screenshots of every built page; screenshots attached to the PR. UI merges only after Yousef's review (PR opened, never merged by the agent).

## Out of scope

- Flowlet/agent integration (chat panel, render surface) — later epic.
- Real auth, multi-tenant, file storage (uploads are metadata-only fictions).
- Real integrations (Gmail/Drive/SharePoint tiles are visual only).
