# Flowlet Platform Orchestration Plan

**Goal:** Get Flowlet demo-ready for a not-yet-chosen demo host while building the platform, per the architecture spec (`docs/superpowers/specs/2026-07-01-flowlet-platform-architecture-design.md`), by orchestrating parallel Orca worktree sessions with Yousef as the sole decision-maker, UI/UX gate, and merger.

**Reframe (2026-07-01):** the demo host is not confirmed (may not be the bank), so all spawned work is host-agnostic. The machinery that makes any host app demo-able fast is the platform itself; demo-bank serves only as test bed and ground truth.

**Operating model:** The `flowlet/architecture` workspace session is the orchestrator. Each session is an Orca worktree child of it, branched from main (so it reads `CLAUDE.md`, `docs/PRD.md`, and the spec), with a scoped prompt embedding the standing gates. The orchestrator monitors terminals, answers only questions already settled by the spec or Yousef, and brings everything else to him.

**Standing gates (non-negotiable):**
- No product, architecture, or scope decisions inside sessions; questions surface and the session pauses.
- All UI/UX pauses for Yousef before building and before merging.
- Sessions open PRs and stop. Only Yousef merges.

---

## Launched portfolio (spawned 2026-07-01, six sessions)

| Worktree | Epic | Scope | Pauses for Yousef at |
|---|---|---|---|
| `eng-202-host-tools` | ENG-202 | OpenAPI→tool adapter, client executor (topology B), annotations→policy→approval cards, live e2e in demo-bank. Additive to `flowlet-agent`. | Any new UI; PR |
| `eng-197-extractor` | ENG-197 | `@flowlet/cli` with `flowlet init`: framework detection, theme extraction, tools.json from OpenAPI, LLM-assisted component wrapping. Validated by diffing against demo-bank's hand-written artifacts. `publish` stubbed. | Schema questions (routed to freeze session); PR |
| `eng-183-saved-flowlets` | ENG-183 | Persistence behind the shell store seam (localStorage/IndexedDB embedded impl), reopen re-runs the data query, library surface. | Library UX proposal before building it; PR |
| `eng-188-automations-proposal` | ENG-188 | Proposals only, no code: DSL shape + worked examples, storage, embedded demo firing path, authoring flow, card outline, open questions with recommendations. | Full stop after the proposal doc — brainstorm with Yousef before any build |
| `eng-204-chat-readiness` | ENG-204 | Audit-first: exercise all three shell surfaces in a real browser, screenshot inventory of every state, prioritized fix list. | Fix-list approval before implementing; PR |
| `contracts-freeze` | (feeds ENG-198) | Additive only: manifest schema (theme/components/tools) as types + JSON Schema, five seam interfaces (Store, CredentialBroker, Executor, Scheduler, Channels). No carve-out. | Mid-flight open-questions review before finalizing; PR |

**Collision map:** adapter+agent code / new CLI package / shell store / docs only / shell UI states / new contract types. The two shell-touching sessions (183, 204) merge sequentially, orchestrator coordinates. The freeze session must not refactor `flowlet-agent` while 202 works in it.

## Held (not spawned)

- **ENG-184 brand-native polish** — host-specific + UI/UX; waits for the demo host pick and Yousef.
- **Runtime carve-out and `apps/cloud` (ENG-198)** — after ENG-202 merges (both touch `flowlet-agent`); carve-out is a follow-on session.
- **ENG-189 memory** — own brainstorm with Yousef first.
- ENG-185 voice, ENG-191 SMS, ENG-190 grounding, ENG-193 full hardening, ENG-194 enterprise — per spec sequencing.

## Orchestration protocol

1. A background watcher exits when any session's agent leaves the working state; the orchestrator then reads that terminal and routes: settled-by-spec answers directly, everything else to Yousef (UI/UX and freeze/automation questions immediately, the rest batched).
2. Merge coordination: Yousef merges; orchestrator sequences rebases (notably shell-touching PRs, and anything vs. the freeze).
3. A crashed or stalled session is reported, not silently restarted.
4. After each merge the orchestrator re-checks this plan, proposes the next spawn (carve-out, ENG-184, wave-1 cloud), and waits for Yousef's go.

## Done means

Demo-ready bar: chat interface demo-proof (204), the agent provably acting through a host's own API with gated approvals (202), saved views surviving reload (183), an automations story Yousef has signed off on (188 post-brainstorm build), and an extractor that can onboard whatever demo host gets picked (197). Platform bar alongside: contracts frozen with Yousef's sign-off, ready for the carve-out and cloud skeleton.
