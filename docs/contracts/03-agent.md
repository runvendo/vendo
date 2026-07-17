# @vendoai/agent — the agent loop

Status: FROZEN (wave-2 gate passed by Yousef, 2026-07-11). Changes now require a major. One job: run the conversation — streaming, tool-calling, context engineering. Nothing else: no tools of its own, no policy, no persistence logic beyond the thread shape. Depends on core + `ai` (Vercel AI SDK `>=6.0.0 <7`) **as a peerDependency** — the host owns the one `ai` install, same singleton rule as React, so the `LanguageModel` a host passes is always assignable (mixed `ai` majors are a documented ai-SDK failure mode). The BYO-LLM seam **is** the ai-SDK `LanguageModel` (Yousef-approved): every provider ships one, and the streaming wire is the ai-SDK UI message stream.

## 1. Public API

```ts
import type { LanguageModel, UIMessage } from "ai";
import type { ToolRegistry, Guard, StoreAdapter, RunContext, AgentRunner, ThreadId, IsoDateTime } from "@vendoai/core";

export function createAgent(config: {
  model: LanguageModel;                    // BYO: Anthropic, OpenAI, Google, Ollama, local — anything with an ai-SDK model
  tools: ToolRegistry;                          // from actions (already guard-bound by the umbrella, 05 §2)
  guard: Guard;                            // directions + reporting; the agent never bypasses the binding
  store?: StoreAdapter;                    // thread persistence; omitted → in-memory threads
  system?: {
    product?: string;                      // host's one-paragraph product brief (init writes .vendo/brief.md)
    instructions?: string;                 // host additions to the system prompt
  };
  context?: {
    maxOutputTokens?: number;
    toolOutputCap?: number;                // truncate giant tool outputs before they hit context
  };
}): VendoAgent;

export interface VendoAgent {
  /** One conversational turn. Returns an ai-SDK UI message stream Response (SSE),
   *  consumable by ai-SDK clients (ui's useVendoThread rides this). */
  stream(input: { threadId?: ThreadId; message: UIMessage; ctx: RunContext }): Promise<Response>;

  threads: {
    get(id: ThreadId, ctx: RunContext): Promise<Thread | null>;
    list(ctx: RunContext): Promise<ThreadSummary[]>;
    delete(id: ThreadId, ctx: RunContext): Promise<void>;
  };

  /** ENG-237 (AGENT-11): drop a subject's in-memory threads when its ephemeral
   *  session is evicted. The umbrella calls this for every subject the store's
   *  idle sweep returns (02 §4); store-backed ephemeral threads live in the
   *  store overlay (cascaded there), so this only bites the no-store (BYO)
   *  composition. */
  evictSubject(subject: string): void;

  /** The AgentRunner seam implementation (core §13) — headless task execution for automations. */
  asRunner(): AgentRunner;
}
```

## 2. Loop semantics (normative)

- Every tool call goes through the guard-bound `ToolRegistry`. A `pending-approval` outcome surfaces as the ai-SDK native approval flow (`needsApproval` / `addToolApprovalResponse`); the turn pauses, the approval decision resumes it.
- `blocked` outcomes are told to the model (it should explain and adapt), never silently swallowed.
- Away tasks (`asRunner()`) run the same loop with `presence: "away"`: no interactive approvals — a `pending-approval` outcome is recorded, the step fails soft, and the run report says so.
- The additive `AgentRunner` task field `abortSignal?: AbortSignal` is passed to the ai-SDK generation call. An in-process abort returns an `AgentRunReport` with status `"stopped"`; runners that predate the optional field remain structurally compatible.
- The loop is venue-agnostic: chat, app editing, and automations all reuse it; venue arrives via `RunContext` and is stamped on every audit event by guard.

## 3. Context engineering (what the system prompt is made of)

Assembled fresh each turn, in this order: (1) Vendo's own operating prompt (owned by this block), (2) the host product brief, (3) `guard.directions(ctx)` — company steering is guard's data, injected here, (4) catalog + theme summary when the venue can render trees, (5) host `instructions`. Memory is a deferred block; no seam is reserved for it in v0.

## 4. Wire protocol

The stream is the standard ai-SDK UI message stream plus the Vendo data parts (`VendoViewPart`, `VendoApprovalPart` — typed in core §16, since ui renders them and imports only core).

## 5. Thread shape (persisted via store)

```ts
export interface Thread { id: ThreadId; subject: string; messages: UIMessage[]; createdAt: IsoDateTime; updatedAt: IsoDateTime; }
export interface ThreadSummary { id: ThreadId; title: string; updatedAt: IsoDateTime; }
```

Threads belong to a principal; `threads.*` never crosses subjects. Ephemeral principals' threads live in the store's per-process in-memory overlay (02 §4) — not a separate agent-owned map — so anon→signed-in migration (02 §4) can move them to the real subject through one seam. When a session is evicted (02 §4 idle sweep / cap overflow), store-overlay threads go with the store cascade, and the umbrella additionally calls `evictSubject` so a no-store agent's in-memory threads are dropped in the same pass — no composition leaks threads past session eviction (ENG-237).

## Amendments

### 2026-07-14 — AI SDK peer range corrected

- **Changed:** Corrected the `ai` peer dependency contract to `>=6.0.0 <7`.
- **Why:** Package manifests have always shipped on the v6 train; the contract document lagged behind them.
- **Approved by:** Yousef, 2026-07-14.

### 2026-07-15 — Ephemeral threads own their overlay in store (ENG-263, parent ENG-264)

- **Changed:** §5 no longer says ephemeral principals get an agent-owned in-memory thread map; ephemeral threads live in the store's per-process overlay (02 §4), so anonymous→signed-in migration moves them through one seam.
- **Why:** ENG-263's anon-merge relocated ephemeral-subject threads out of `packages/agent/src/threads.ts` into the store overlay; the frozen prose described the pre-merge path.
- **Authorized by:** the Yousef-approved block-actions design spec (`docs/superpowers/specs/2026-07-14-block-actions-design.md`).

### 2026-07-16 — Thread eviction on session end (AGENT-11, ENG-237, wave 4)

- **Changed:** §1 adds `VendoAgent.evictSubject(subject)` — drops a subject's in-memory (no-store/BYO composition) threads when its ephemeral session is evicted; the umbrella calls it per subject returned by the store's idle sweep (02 §4). A no-op in the composed store-backed default, where ephemeral threads live in the store overlay and are cascaded there.
- **Changed:** §5 gains the eviction leg: session eviction removes ephemeral threads from every composition — store overlay via the store cascade, agent memory via `evictSubject` — in the same pass.
- **Why:** Wave 4 (PR #301) shipped the eviction surface on this FROZEN interface; the frozen prose covered ephemeral threads' migration path but not their end of life.
- **Approved by:** Yousef, 2026-07-16 (inventory: `docs/superpowers/specs/2026-07-16-wave4-contract-amendment-inventory.md`).
