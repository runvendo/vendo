# @vendoai/agent — the agent loop

Status: DRAFT (wave 2). One job: run the conversation — streaming, tool-calling, context engineering. Nothing else: no tools of its own, no policy, no persistence logic beyond the thread shape. Depends on core + `ai` (Vercel AI SDK ≥ 5) — the BYO-LLM seam **is** the ai-SDK `LanguageModel` (Yousef-approved): every provider ships one, and the streaming wire is the ai-SDK UI message stream.

## 1. Public API

```ts
import type { LanguageModel, UIMessage } from "ai";
import type { ToolSet, Guard, StoreAdapter, RunContext, AgentRunner, ThreadId, InstallId, Tree, RiskLabel, ApprovalId, IsoDateTime } from "@vendoai/core";

export function createAgent(config: {
  model: LanguageModel;                    // BYO: Anthropic, OpenAI, Google, Ollama, local — anything with an ai-SDK model
  tools: ToolSet;                          // from actions (already guard-bound by the umbrella, 05 §2)
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

  /** The AgentRunner seam implementation (core §13) — headless task execution for automations. */
  asRunner(): AgentRunner;
}
```

## 2. Loop semantics (normative)

- Every tool call goes through the guard-bound `ToolSet`. A `pending-approval` outcome surfaces as the ai-SDK native approval flow (`needsApproval` / `addToolApprovalResponse`); the turn pauses, the approval decision resumes it.
- `blocked` outcomes are told to the model (it should explain and adapt), never silently swallowed.
- Away tasks (`asRunner()`) run the same loop with `presence: "away"`: no interactive approvals — a `pending-approval` outcome is recorded, the step fails soft, and the run report says so.
- The loop is venue-agnostic: chat, app editing, and automations all reuse it; venue arrives via `RunContext` and is stamped on every audit event by guard.

## 3. Context engineering (what the system prompt is made of)

Assembled fresh each turn, in this order: (1) Vendo's own operating prompt (owned by this block), (2) the host product brief, (3) `guard.directions(ctx)` — company steering is guard's data, injected here, (4) catalog + theme summary when the venue can render trees, (5) host `instructions`. Memory is a deferred block; no seam is reserved for it in v0.

## 4. Wire protocol

The stream is the standard ai-SDK UI message stream plus Vendo data parts (typed in this package, re-exported by ui):

```ts
export interface VendoViewPart { type: "data-vendo-view"; installId: InstallId; tree: Tree }        // a rendered app surface in-thread
export interface VendoConsentPart { type: "data-vendo-consent"; toolCallId: string; risk: RiskLabel; approvalId?: ApprovalId }  // receipt/approval metadata beside native tool parts
```

## 5. Thread shape (persisted via store)

```ts
export interface Thread { id: ThreadId; subject: string; tenantId: string; messages: UIMessage[]; createdAt: IsoDateTime; updatedAt: IsoDateTime; }
export interface ThreadSummary { id: ThreadId; title: string; updatedAt: IsoDateTime; }
```

Threads belong to a principal; `threads.*` never crosses subjects. Ephemeral principals get in-memory threads regardless of store.
