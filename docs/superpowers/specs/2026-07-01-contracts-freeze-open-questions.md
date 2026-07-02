# Contracts Freeze — Open Questions

**Date:** 2026-07-01
**Status:** AWAITING REVIEW (Yousef, mid-flight)
**Branch:** `yousef/contracts-freeze` — contracts are drafted, tested, and committed per the recommendations below; every question here can still be changed cheaply before the PR.

How to answer: each question needs one letter. "Confirm" questions can be answered in bulk ("confirm all").

---

## Manifest schema

### Q1. Annotation vocabulary: Flowlet-native or MCP hints?

`tools.json` needs the spec's "mutating/dangerous annotations". MCP already has a vocabulary (`readOnlyHint`, `destructiveHint`, `idempotentHint` — all optional), which `flowlet-agent`'s internal `ToolDescriptor` uses today.

- **A (draft, recommended):** Flowlet-native, REQUIRED `{ mutating, dangerous, idempotent? }`. Policy needs definite values — an optional "hint" forces every consumer to pick a default, and a wrong default on `dangerous` is a safety bug. The MCP mapping (`readOnlyHint = !mutating`, `destructiveHint = dangerous`) is documented in the type and docs, so ingestion into the runtime's descriptor table is mechanical.
- **B:** Adopt MCP hint names/optionality verbatim for ecosystem familiarity; policy layers pick conservative defaults for missing hints.

### Q2. Tool binding: freeze a minimal `http` shape now, or leave opaque?

The client executor (ENG-202) and extractor (ENG-197) both need to know how a tool call physically reaches the host API.

- **A (draft, recommended):** freeze a minimal `http` binding now — `{ type: "http", method, path }` with `{param}` path templates filled from tool input by name — inside a discriminated union on `type` so trpc/graphql land additively later. Both tracks can build immediately without inventing private shapes.
- **B:** `binding: unknown` and let ENG-202 define it. Avoids a wrong guess but guarantees a schema rev within weeks and two tracks negotiating a shape mid-flight.

Sub-point if A: query/body parameter mapping is deliberately NOT frozen (only path templates are). Extractors put non-path input into query (GET) or JSON body (others) by convention until a real case demands explicit mapping. OK?

### Q3. Theme schema ownership: duplicate now, fold later?

Core cannot import `brandTokensSchema` from `@flowlet/components` (dependency points the other way), and this session is additive-only.

- **A (draft, recommended):** core carries its own structurally identical schema; a conformance test in flowlet-components fails CI if they ever diverge (it compares generated JSON Schemas, so any drift is caught). A later session folds `brand.ts` onto the core schema and deletes the duplicate.
- **B:** move `brandTokensSchema` into core now — cleaner, but a refactor of F3/F4 code, which this session is forbidden to do.

### Q4. Published manifest vs component bundle — confirm

Draft: the published manifest embeds component *descriptors* only (name, description, propsSchema as JSON Schema); the compiled sandbox bundle is a separate artifact referenced by the registry row, keyed by the same hash. The manifest stays small, diffable, reviewable (ENG-194's queue reads it); the bundle is a blob. Confirm?

### Q5. tools.json file shape — confirm

Draft: `tools.json` = `{ version: 1, tools: [...], events: [...] }` — host events live in tools.json per architecture Decision 3, not a fourth artifact. Confirm?

## Seams

### Q6. Automation spec opacity — confirm

Draft: `AutomationRecord.spec: unknown` until ENG-188's brainstorm freezes the DSL (proposals are in flight there — JSONata-flavored step graph etc.). The store freezes only identity, lifecycle (`enabled | paused`), and run history, which every DSL design needs. Confirm?

### Q7. Memory reservation — confirm

Draft: NO `memory` member on `Store` yet. The architecture deliberately leaves memory (ENG-189) undefined; adding a member later is purely additive. The alternative — a placeholder `memory?: unknown` — freezes nothing and invites accidental coupling. Confirm?

### Q8. Store granularity: one aggregate or five parameters?

- **A (draft, recommended):** one `Store` aggregating named sub-stores (`threads`, `flowlets`, `automations`, `audit`). One injection point; sub-stores keep concerns separable and independently testable.
- **B:** each sub-store injected as its own top-level seam. More flexible partial deployments, but the runtime constructor grows and the architecture names "Store" as ONE seam of five.

### Q9. Executor result shape: single outcome or streaming?

- **A (draft, recommended):** `execute() → Promise<{ result } | { error }>` — one outcome per call, mirroring the existing `ActionResult`. The ai SDK client-tool round trip is itself request/response, so a streaming seam would have nothing to carry on the main path.
- **B:** `ReadableStream` results for long-running host calls. Can be added later as a new method without breaking A.

### Q10. Scheduler scope: time triggers only — confirm

Draft: `Scheduler` owns `cron`/`at` only; host webhooks and Composio triggers are ingest paths that invoke the same registered firing handler directly. Keeps the seam implementable by "none, or host cron" in embedded mode, per the architecture table. Confirm?

### Q11. Channels: message-shaped now, voice reserved — confirm

Draft: `deliver({ channel: "in-app" | "sms", principal, text, threadId? })`. Realtime voice is a session, not a message — it gets its own contract at ENG-185 and is deliberately not squeezed into `deliver`. Confirm?

### Q12. Credential input: opaque or typed?

- **A (draft, recommended):** `authenticate(credential: unknown)` — cloud passes the vouch JWT string, embedded passes whatever in-process handle the host has. Typing it as `string` would force embedded hosts to fake-serialize.
- **B:** typed `VouchCredential` union now. Prettier, but invents an embedded credential shape nobody has asked for yet.

## Conventions

### Q13. Timestamps: ISO 8601 strings — confirm

Draft: all seam/store timestamps are ISO 8601 strings (portable across the wire and JSON storage; `Date` objects don't survive serialization). Confirm?

---

## Not questions, but flagged

- **Branch name:** worktree branch renamed `yousefh409/contracts-freeze` → `yousef/contracts-freeze` per the session mandate.
- **Pre-existing, untouched:** (1) `pnpm lint` fails repo-wide after any fresh `pnpm build` — demo-bank's eslint lints the generated, gitignored `public/flowlet/components-sandbox.js` bundle; (2) test files are excluded from every package's `tsc` typecheck, and `flowlet-core/src/genui/resolve.test.ts` has 6 latent type errors under `noUncheckedIndexedAccess`. Both predate this branch; neither was fixed here (out of scope).
