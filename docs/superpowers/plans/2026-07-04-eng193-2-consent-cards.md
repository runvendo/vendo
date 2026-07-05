# ENG-193 Item 2 — Consent channel + approval card v2 + receipts: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **UI gate: Yousef explicitly waived the build-time UI review for this run (2026-07-04, "build it all, review at the end") — proceed through Tasks 8–14 without pausing; the PR stays unmerged and every visual surface gets screenshots in the PR for his single end review.**
>
> **Revised 2026-07-04** after `origin/main` was merged into this branch (merge commit `0f4d3436`): `@flowlet/next` (PR #33) now exists in the tree and `apps/demo-bank` mounts `createFlowletHandler`. The production consent route + policy-stack composition moved into `createFlowletHandler` (new Task 5); the accounting demo keeps hand-rolled parallel wiring as the verification host. See the updated "Plan deviations" section.

**Goal:** Ship-order item 2 from `docs/superpowers/specs/2026-07-02-eng193-permissions-design.md` §10: the consent wire channel (§4.5), approval card v2 (§3 Moments 2/3/4/6), and receipts, wired onto the item-1 engine that already landed (`policy/tier.ts`, `grant-policy.ts`, `grant-match.ts`, `grant-manager.ts`, `grant-store.ts`, the in-memory `AuditLog`). No judge, no fades, no Trust screen, no steering — those are items 3, 5, 6.

**Architecture:**
- `@flowlet/core` gains a `data-consent` part on `FlowletUIMessage` (tier metadata riding beside the SDK's native approval boolean) and a new `src/consent.ts` with the `ConsentRequest`/`ConsentResponse` zod schemas (v1-narrowed to `kind: "approval"`).
- `@flowlet/runtime`'s `wrapTool`/`wrapClientTool` gain an optional stream writer; at `needsApproval` time (which the ai SDK calls for **every** tool call, not just ones that pause) they write **one** persistent `data-consent` part per non-read tool call. This single write site backs both the approval card's tier/unverified rendering (when the decision is `"approve"`) and the receipt line (when the decision is `"allow"` — a silently-executed mutating call, spec Moment 2). A new `packages/flowlet-runtime/src/consent.ts` exports `handleConsent(deps)`, the server-validated grant-creation endpoint logic. The engine gains an `onSettled` hook so a host can persist the turn's final messages through the Store seam's `ThreadStore`.
- `@flowlet/shell` gets the card v2 work: `ApprovalCard` grows a ceremony variant + unverified tag + question-form title + untruncated critical fields; a new `ApprovalBatchCard` groups sibling approval-requested parts of the same tool in one assistant message; `ActivityStep` grows a receipt row. A new optional `sendConsent` seam on `FlowletShellProvider` posts `ConsentResponse`s; `FlowletThread.tsx`'s `approve`/`decline` call it before resolving the SDK's own approval.
- `@flowlet/next` (the production path — `apps/demo-bank` mounts it since PR #33) gains a `store` option (grants/audit/threads with in-memory defaults), a `consent` route in `createFlowletHandler`'s catch-all, thread persistence in its `handleChat`, and a `composeProductionPolicy` wrapper that layers `auditPolicy` + `grantPolicy` around whatever base policy the host supplies (`options.policy ?? defaultFlowletPolicy`) — demo-bank gets the full item-1 stack with zero app changes.
- The accounting demo (`apps/demo-accounting`, NOT migrated to `@flowlet/next`) gets thin parallel wiring of the same `handleConsent` + policy stack in its hand-rolled routes, because it is the verification host (deviation #1) — **before this plan, zero non-test code composes the item-1 primitives anywhere** (verified: `grantPolicy(`/`auditPolicy(` have no call sites outside `packages/flowlet-runtime/src/**/*.test.ts`).

**Tech Stack:** TypeScript, zod, vitest (`pnpm --filter <pkg> test`), `@testing-library/react`, the ai SDK v6 (`ai@6.0.28`), Playwright MCP for the browser-verification task.

**Conventions:** run tests with `pnpm --filter <pkg> test -- <file>`; typecheck with `pnpm typecheck`. Commit after each task. Follow existing file style: module docstring explaining the WHY, named exports, no default exports. Targeted `Edit`s over rewrites.

---

## Plan deviations from scope rulings

*(Revised 2026-07-04 after `origin/main` merged into the branch — merge commit `0f4d3436` brought in `@flowlet/next` and demo-bank's migration to it.)* The scope rulings below don't fully match the tree. Each is resolved to the closest faithful alternative — none dropped silently.

1. **Ruling #3 targets `@flowlet/next`'s `createFlowletHandler` — now real, but only `demo-bank` mounts it.** Post-merge facts (all verified in the tree): `packages/flowlet-next` exists; `apps/demo-bank/src/app/api/flowlet/[...path]/route.ts` mounts `createFlowletHandler({ policy: demoPolicy, ... })`; `apps/demo-accounting` and `apps/gmail` still hand-roll their `/api/flowlet/*` routes (accounting: `chat`/`action`/`tick`, untouched by the merge). **Resolution:** `handleConsent(deps)` lives in `@flowlet/runtime` exactly as ruled (Task 4 — transport-agnostic, portable). The PRODUCTION mount is `createFlowletHandler`: Task 5 adds a `consent` case to its catch-all, a `store` option (grants/audit/threads, in-memory defaults), thread persistence in its `handleChat`, and the production policy-stack composition — demo-bank inherits all of it with no app change. The ACCOUNTING demo gets a thin parallel mount of the same `handleConsent` in its hand-rolled routes (Tasks 6–7) because it stays the verification host (see #5) and migrating it to `@flowlet/next` mid-item is scope creep this plan deliberately avoids (its chat route carries a generation-keyed agent cache + its own automations world + tick choreography the runbook depends on).

2. **Ruling #3(a) assumes a Store-backed `ThreadStore` already persists chat messages.** It doesn't, on EITHER path: `apps/demo-accounting`'s `/api/flowlet/chat` is fully stateless (the client resends the whole message array every turn — `ChatRequestBody { messages?: FlowletUIMessage[] }`), and `@flowlet/next`'s `handleChat` (`packages/flowlet-next/src/chat.ts`) is equally stateless — no Store seam exists anywhere in that package's options. **Resolution:** Task 3 adds the engine-side hook (`FlowletAgentConfig.onSettled`, backed by `createUIMessageStream`'s `onFinish({messages})` callback, confirmed in `ai@6.0.28`'s type surface); Task 5 adds persistence to `@flowlet/next`'s `handleChat`; Task 6 adds the same to the accounting demo's hand-rolled `chat-handler.ts`. The correlation key is the ai SDK's own `chatId` — confirmed by reading `HttpChatTransport.sendMessages`'s compiled source (`ai@6.0.28/dist/index.js:11705`): the default POST body is `{ id: options.chatId, messages, trigger, messageId }` — and Cadence's `FlowletRoot.tsx` **already** passes a stable `threadId="cadence-demo"` into `FlowletProvider`, which becomes the `Chat`'s `id`. So the server already receives this id on every request; neither chat handler is reading it yet. Because `ThreadStore.create()` mints its own store-assigned id (an existing, deliberate seam rule — "the store assigns `id`... callers never supply them"), both paths add a small `clientThreadId → storeThreadId` map.

3. **Ruling #7 asks for a critical-action screenshot from `pnpm demo:accounting`, but Cadence has no naturally critical (`dangerous: true`) tool.** Grepped `apps/demo-accounting/openapi.json`: no `x-flowlet-dangerous`, no `DELETE` operations — every write is `sendClientMessage` (a portal message) or `setDocumentStatus` (receive/verify/reject a document), neither money nor a deletion. (demo-bank is no better: its OpenAPI's only non-GET operation is `createOrder`.) **Resolution:** using the design's own host-authority rule (§9 resolved decision 5 — "host's tool config is law"), Task 13 adds `"x-flowlet-dangerous": true` to `setDocumentStatus` in the demo's OpenAPI spec — a one-line, host-scoped, easily-revertable config choice, not a product claim — purely so the ceremony card has a real tool to render against in the live demo. Flagged plainly in that task and in the verification screenshot captions.

4. **Ruling #4's `composePolicy` snippet names a bare `annotationPolicy()` as the inner policy `grantPolicy` wraps.** Read literally that would regress both hosts: `demo-accounting`'s real base decision layer is `namePolicy` (`apps/demo-accounting/src/flowlet/policy.ts` — calls `annotationPolicy()` only for client-executed tools, Composio-verb split otherwise), and `@flowlet/next`'s is `options.policy ?? defaultFlowletPolicy` (`default-policy.ts` — annotation + verb heuristic, fail-safe approve). Dropping in a bare `annotationPolicy()` would mis-classify every Composio tool. **Resolution:** the stack wraps each host's REAL base layer. In `@flowlet/next` (Task 5) a new `composeProductionPolicy(base, {grants, audit, ...})` helper produces `composePolicy(auditPolicy(...), grantPolicy(base, ...))` and `assemble()` applies it to `options.policy ?? defaultFlowletPolicy` — so demo-bank's injected `demoPolicy` is wrapped automatically. In the accounting demo (Task 7) the same shape wraps its `namePolicy`. This is the ruling's intent ("compose the full item-1 stack onto the production base layer") applied to what the base layers actually are.

5. **Verification host stays `pnpm demo:accounting` (unchanged from ruling #7) even though demo-bank is the `@flowlet/next` reference mount.** Reasoning: the accounting demo has the full consent choreography this item needs on screen — the batch beat ("chase everyone overdue" → multiple sibling `GMAIL_SEND_EMAIL` approvals in one turn), live Composio Gmail/Calendar, and a maintained runbook (`docs/superpowers/CADENCE-DEMO-RUNBOOK.md`); demo-bank's only OpenAPI write is `createOrder` and its Composio flow requires an on-screen connect step. The `@flowlet/next` path is verified by Task 5's unit tests (route-level, no browser); a demo-bank browser pass is a cheap optional add-on in Task 14 if Yousef wants the production mount seen live.

---

### Task 1: Consent wire types in `@flowlet/core`

**Files:**
- Modify: `packages/flowlet-core/src/protocol.ts`
- Create: `packages/flowlet-core/src/consent.ts`
- Modify: `packages/flowlet-core/src/index.ts`
- Test: `packages/flowlet-core/src/consent.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { consentRequestSchema, consentResponseSchema } from "./consent";

describe("consent wire types", () => {
  it("accepts a v1 approval consent request", () => {
    const req = consentRequestSchema.parse({
      id: "call-1",
      kind: "approval",
      tier: "act",
      toolName: "GMAIL_SEND_EMAIL",
      inputPreview: "To: acme@example.com",
    });
    expect(req.tier).toBe("act");
  });

  it("rejects a kind other than approval (v1-narrowed union)", () => {
    expect(() =>
      consentRequestSchema.parse({
        id: "call-1", kind: "fade-proposal", tier: "act",
        toolName: "x", inputPreview: "",
      }),
    ).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      consentRequestSchema.parse({
        id: "call-1", kind: "approval", tier: "act",
        toolName: "x", inputPreview: "", surprise: true,
      }),
    ).toThrow();
  });

  it("accepts a yes decision with a grant draft", () => {
    const res = consentResponseSchema.parse({
      id: "call-1",
      decision: "yes",
      grant: { tool: "GMAIL_SEND_EMAIL", scope: { kind: "tool" }, duration: "standing" },
    });
    expect(res.decision).toBe("yes");
  });

  it("accepts a subset decision with a toolCallId list", () => {
    const res = consentResponseSchema.parse({
      id: "call-1", decision: "subset", subset: ["call-1", "call-2"],
    });
    expect(res.subset).toEqual(["call-1", "call-2"]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

`pnpm --filter @flowlet/core test -- consent.test.ts`

- [ ] **Step 3: Implement `consent.ts`**

```ts
import { z } from "zod";
import { grantDurationSchema, grantScopeSchema } from "./seams/grants";

/**
 * The consent channel (ENG-193 spec §4.5) — a Flowlet-owned request/response
 * pair riding BESIDE the ai SDK's native `{id, approved}` approval boolean,
 * which stays the resume trigger for gated tool calls (@flowlet/react,
 * `addToolApprovalResponse`, untouched). This channel carries everything the
 * boolean can't: tier/reason for card presentation, batch subset choices, and
 * an optional grant draft the server validates before minting a
 * `PermissionGrant` (`createGrantManager.create`, ENG-193 §4.3).
 *
 * v1-narrowed to `kind: "approval"` only (Yousef ruling, item-2 scope). The
 * discriminated union is the extension point: `"fade-proposal"` (§4.4) and
 * `"parked-action"` (§4.6) join it in later items. Do not widen this
 * speculatively — each new kind ships with its own consumer.
 */
export const consentRequestSchema = z
  .object({
    /** Correlates to `ConsentResponse.id`. In v1 this is the ai SDK `toolCallId`
     *  the request concerns — there is no separate server-minted consent id. */
    id: z.string(),
    kind: z.literal("approval"),
    tier: z.enum(["act", "critical"]),
    /** Plain-language reason (judge escalations, item 3). Reserved — empty/absent today. */
    reason: z.string().optional(),
    toolName: z.string(),
    /** Untruncated material fields — never the card's own truncated preview. */
    inputPreview: z.string(),
    batch: z.object({ id: z.string(), items: z.array(z.string()) }).optional(),
    stepUp: z.boolean().optional(),
  })
  .strict();
export type ConsentRequest = z.infer<typeof consentRequestSchema>;

/** A grant the server may mint if the response says yes — narrowed to what a
 *  human gesture can specify; the server derives `descriptorHash`/`source`
 *  (`handleConsent`, Task 4) — a client can never author those fields. */
export const consentGrantDraftSchema = z
  .object({
    tool: z.string(),
    scope: grantScopeSchema,
    duration: grantDurationSchema,
  })
  .strict();
export type ConsentGrantDraft = z.infer<typeof consentGrantDraftSchema>;

export const consentResponseSchema = z
  .object({
    id: z.string(),
    decision: z.enum(["yes", "no", "subset"]),
    /** toolCallIds included in a batch decision — informational context for
     *  audit even though each is independently confirmed by its own POST
     *  (`handleConsent` resolves one toolCallId per call, ENG-193 §4.5). */
    subset: z.array(z.string()).optional(),
    grant: consentGrantDraftSchema.optional(),
  })
  .strict();
export type ConsentResponse = z.infer<typeof consentResponseSchema>;
```

- [ ] **Step 4: Extend `FlowletDataParts` in `protocol.ts`**

Replace the existing doc comment and type (currently lines 34–44) with:

```ts
/**
 * Flowlet's typed data-* parts layered on the ai SDK UIMessage.
 *
 * Approval PAUSING is NOT here: human-in-the-loop tool approval is handled by
 * the ai SDK natively (`needsApproval` tools + `addToolApprovalResponse`).
 * `consent` below is TIER METADATA riding beside that native mechanism — the
 * engine writes one persistent `data-consent` part per non-read tool call
 * (ENG-193 §4.1/§4.5), which backs both the approval card's ceremony/unverified
 * rendering (when the call paused) and the receipt line (when it didn't —
 * spec Moment 2, a silently-allowed mutating call still gets a receipt).
 */
export interface ConsentTierPart {
  toolCallId: string;
  tier: "act" | "critical";
  unverified: boolean;
  /** Reserved for the judge's escalation reason (item 3). Empty/absent today. */
  reason?: string;
}

export type FlowletDataParts = {
  ui: UINode;
  consent: ConsentTierPart;
};
```

- [ ] **Step 5: Export the new module** — add `export * from "./consent";` to `packages/flowlet-core/src/index.ts` (mirror the existing flat list, e.g. right after `export * from "./protocol";`).

- [ ] **Step 6: Run test — expect PASS. Run `pnpm --filter @flowlet/core test` and `pnpm typecheck`.**

- [ ] **Step 7: Commit** — `feat(core): consent channel wire types + data-consent part (ENG-193 §4.5)`

---

### Task 2: Thread the stream writer through `wrapTool`/`wrapClientTool`/`buildToolset`

**Files:**
- Modify: `packages/flowlet-runtime/src/wrap-tool.ts`
- Modify: `packages/flowlet-runtime/src/wrap-client-tool.ts`
- Modify: `packages/flowlet-runtime/src/toolset.ts`
- Modify: `packages/flowlet-runtime/src/policy/types.ts` (additive `threadId` on `PolicyContext`)
- Test: `packages/flowlet-runtime/src/wrap-tool.test.ts` (extend), `packages/flowlet-runtime/src/wrap-client-tool.test.ts` (extend), `packages/flowlet-runtime/src/toolset.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `wrap-tool.test.ts` (mirror the file's existing fixture pattern — a `descriptor` with `annotations`, a `fixed(decision)` policy stub, a `Tool` with `execute`):

```ts
it("writes ONE data-consent part at needsApproval time for a non-read tool, decision 'approve'", async () => {
  const writes: unknown[] = [];
  const writer = { write: (part: unknown) => writes.push(part) } as never;
  const descriptor: ToolDescriptor = {
    name: "send_email", source: "caller",
    annotations: { readOnlyHint: false }, hasExecute: true, kind: "function",
  };
  const wrapped = wrapTool({
    name: "send_email",
    tool: { execute: async () => "ok" } as unknown as Tool,
    descriptor, policy: fixed("approve"), principal: { userId: "u" }, writer,
  });
  await wrapped.needsApproval!({}, { toolCallId: "call-1", messages: [] } as never);
  expect(writes).toEqual([
    { type: "data-consent", id: "consent-call-1", data: { toolCallId: "call-1", tier: "act", unverified: false } },
  ]);
});

it("writes the data-consent part even when the decision is 'allow' (receipts, Moment 2)", async () => {
  const writes: unknown[] = [];
  const writer = { write: (part: unknown) => writes.push(part) } as never;
  const descriptor: ToolDescriptor = {
    name: "send_email", source: "caller",
    annotations: { readOnlyHint: false }, hasExecute: true, kind: "function",
  };
  const wrapped = wrapTool({
    name: "send_email",
    tool: { execute: async () => "ok" } as unknown as Tool,
    descriptor, policy: fixed("allow"), principal: { userId: "u" }, writer,
  });
  await wrapped.needsApproval!({}, { toolCallId: "call-2", messages: [] } as never);
  expect(writes).toHaveLength(1);
  expect((writes[0] as { data: { tier: string } }).data.tier).toBe("act");
});

it("writes NOTHING for a read-tier tool", async () => {
  const writes: unknown[] = [];
  const writer = { write: (part: unknown) => writes.push(part) } as never;
  const descriptor: ToolDescriptor = {
    name: "get_x", source: "caller",
    annotations: { readOnlyHint: true }, hasExecute: true, kind: "function",
  };
  const wrapped = wrapTool({
    name: "get_x", tool: { execute: async () => "ok" } as unknown as Tool,
    descriptor, policy: fixed("allow"), principal: { userId: "u" }, writer,
  });
  await wrapped.needsApproval!({}, { toolCallId: "call-3", messages: [] } as never);
  expect(writes).toHaveLength(0);
});

it("works with no writer at all (no card client, no crash)", async () => {
  const descriptor: ToolDescriptor = {
    name: "send_email", source: "caller",
    annotations: { readOnlyHint: false }, hasExecute: true, kind: "function",
  };
  const wrapped = wrapTool({
    name: "send_email", tool: { execute: async () => "ok" } as unknown as Tool,
    descriptor, policy: fixed("approve"), principal: { userId: "u" },
  });
  await expect(wrapped.needsApproval!({}, { toolCallId: "call-4", messages: [] } as never)).resolves.toBe(true);
});
```

Append the mirror set to `wrap-client-tool.test.ts` (same four cases, using `wrapClientTool` with a no-`execute` tool object, per its existing fixture pattern).

Add one test to `toolset.test.ts`: a source tool with `destructiveHint: false`, assembled via `buildToolset({ sources, policy: fixed("approve"), principal, writer })`, then calling `needsApproval` on the wrapped result and asserting `writer.write` was called — confirming `buildToolset` actually threads `writer` through to `wrapTool`.

- [ ] **Step 2: Run — expect FAIL (property `writer` doesn't exist / `writes` stays empty).**

`pnpm --filter @flowlet/runtime test -- wrap-tool.test.ts wrap-client-tool.test.ts toolset.test.ts`

- [ ] **Step 3: Add `threadId` to `PolicyContext`** (`policy/types.ts`) — additive field, item-2 slice of what item 3's fuller judge context will extend further:

```ts
  /**
   * Stable per-conversation id (ENG-193 §4.3 contextKey — enables
   * session/task-duration grants). Absent when the caller supplied none; the
   * engine falls back to its own minted run id (see engine.ts).
   */
  threadId?: string;
```

Add this member to the `PolicyContext` interface right after `toolCallId`.

- [ ] **Step 4: Implement in `wrap-tool.ts`**

```ts
import type { Tool, ToolExecutionOptions, UIMessageStreamWriter } from "ai";
import type { FlowletUIMessage } from "@flowlet/core";
import type { ApprovalDecision, ApprovalPolicy, PolicyContext } from "./policy";
import type { ToolDescriptor } from "./descriptor";
import type { FlowletPrincipal } from "./principal";
import { FlowletError, policyDenied } from "./errors";
import { dangerTier, isUnverified } from "./policy/tier";
```

Extend `WrapToolArgs`:

```ts
export interface WrapToolArgs {
  name: string;
  tool: Tool;
  descriptor: ToolDescriptor;
  policy: ApprovalPolicy;
  principal: FlowletPrincipal;
  /** Stable per-conversation id threaded into PolicyContext (ENG-193 §4.3). */
  threadId?: string;
  /**
   * The run's stream writer (ENG-193 §4.5/§6.5). Optional — a caller with no
   * consent-card client (tests, the local F1 transport) simply gets no
   * data-consent parts, never a broken tool. When present, `needsApproval`
   * writes ONE persistent `data-consent` part for any NON-READ tool call,
   * regardless of the decision: an "approve" write lets the card render
   * tier/unverified before the user answers; an "allow" write is what lets a
   * settled mutating call still show a receipt (spec Moment 2 — asked, done,
   * never invisible). `needsApproval` runs for every tool call the SDK
   * generates (that's how it decides whether to pause), so this is the one
   * call site both cases need.
   */
  writer?: UIMessageStreamWriter<FlowletUIMessage>;
}
```

Inside `wrapTool`, after destructuring `const { name, tool, descriptor, policy, principal, threadId, writer } = args;`, add:

```ts
  function buildCtx(input: unknown, toolCallId?: string): PolicyContext {
    return { toolName: name, input, descriptor, principal, toolCallId, threadId };
  }

  function writeConsentPart(toolCallId: string): void {
    if (!writer) return;
    const tier = dangerTier(descriptor);
    if (tier === "read") return; // cards/receipts are for mutating calls only
    writer.write({
      type: "data-consent",
      id: `consent-${toolCallId}`,
      data: { toolCallId, tier, unverified: isUnverified(descriptor) },
    });
  }
```

(Replace the existing `buildCtx` definition with this one — same body plus `threadId`.) Then change `needsApproval` to:

```ts
    needsApproval: async (input: unknown, options: { toolCallId: string }): Promise<boolean> => {
      const decision = await evaluate(input);
      writeConsentPart(options.toolCallId);
      return decision === "approve";
    },
```

Leave `execute` unchanged (it already re-evaluates fresh and calls `onExecuted`; no writer touch needed there — the single `needsApproval`-time write already covers both the card and the receipt case).

- [ ] **Step 5: Implement in `wrap-client-tool.ts`** (mirror, minus `execute` entirely since client tools have none):

Add the same imports (`UIMessageStreamWriter`, `FlowletUIMessage`, `dangerTier`, `isUnverified`), extend `WrapClientToolArgs` with the same `threadId?`/`writer?` fields, update `buildCtx` to include `threadId`, add the same `writeConsentPart` helper, and change:

```ts
  return {
    ...tool,
    needsApproval: async (input: unknown, options: { toolCallId: string }): Promise<boolean> => {
      const decision = await policy.evaluate(buildCtx(input));
      if (decision === "deny") {
        throw new FlowletError("policy", `tool "${name}" denied by approval policy`);
      }
      writeConsentPart(options.toolCallId);
      return decision === "approve";
    },
  };
```

- [ ] **Step 6: Thread `threadId`/`writer` through `buildToolset`** (`toolset.ts`) — add both as optional members of `buildToolset`'s args object, and pass them into both `wrap({...})` call sites (the object literal already includes `name, tool, descriptor, policy, principal`; add `threadId, writer` to it).

- [ ] **Step 7: Run all four test files — PASS. Run `pnpm --filter @flowlet/runtime test` (whole package) and `pnpm typecheck` — PASS.**

- [ ] **Step 8: Commit** — `feat(runtime): stream data-consent tier metadata at needsApproval time (ENG-193 §4.5)`

---

### Task 3: Engine wiring — writer/threadId into `buildToolset`, `onSettled` persistence hook

**Files:**
- Modify: `packages/flowlet-core/src/agent.ts` (additive `threadId?` on `RunInput`)
- Modify: `packages/flowlet-runtime/src/engine.ts`
- Test: `packages/flowlet-runtime/src/engine.test.ts` (extend)

- [ ] **Step 1: Failing tests** — append to `engine.test.ts` (mirror its existing "drive a stubbed streamText" fixture pattern):

```ts
it("writes a data-consent part for a gated tool call", async () => {
  // Fixture: a config.tools entry with destructiveHint: false whose call the
  // mocked model requests and the policy approves. Collect UIMessageChunks
  // from agent.run({...}) and assert one chunk has type "data-consent".
});

it("calls onSettled with the run's final messages once the stream finishes", async () => {
  // Fixture: config.onSettled = vi.fn(); drain the run() stream to completion;
  // assert onSettled was called once with an array of FlowletUIMessage.
});

it("threads a caller-supplied threadId into PolicyContext (contextKey)", async () => {
  // Fixture: a policy stub that records ctx.threadId; call
  // agent.run({ ..., threadId: "conv-1" }); drain the stream; assert the
  // recorded threadId === "conv-1".
});

it("falls back to its own minted threadId when the caller supplies none", async () => {
  // Same as above but omit RunInput.threadId; assert the recorded threadId
  // matches the `thread-${n}` shape already used for FlowletMetadata.threadId.
});
```

Write these as real tests using the exact mock-model/mock-policy scaffolding already present at the top of `engine.test.ts` (do not invent a new harness — extend the existing one).

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @flowlet/runtime test -- engine.test.ts`

- [ ] **Step 3: Extend `RunInput`** (`packages/flowlet-core/src/agent.ts`):

```ts
export interface RunInput {
  messages: FlowletUIMessage[]; // carry Flowlet metadata + data parts at the call site
  tools: ToolSet;               // ai SDK tool set (Record<string, Tool>)
  system?: string;
  principal?: unknown;       // opaque in F1
  signal: AbortSignal;
  /**
   * Stable per-conversation id (ENG-193 §4.3 contextKey). Absent when the
   * caller doesn't track one; the engine mints its own per-run id either way
   * (FlowletMetadata.threadId), but a caller-supplied id lets grants persist
   * ACROSS turns of the same conversation rather than resetting every call.
   */
  threadId?: string;
}
```

- [ ] **Step 4: Extend `FlowletAgentConfig` and `run()` in `engine.ts`**

Add to `FlowletAgentConfig` (after `policyVersion`):

```ts
  /**
   * Called once the run's stream settles with the FULL updated message list
   * (ENG-193 §6.2 — persistence for the consent endpoint's "load the thread's
   * messages" step, Task 4). Errors thrown here are logged, never surfaced to
   * the model or the client — persistence must not take down a finished run.
   */
  onSettled?: (messages: FlowletUIMessage[], principal: FlowletPrincipal) => void | Promise<void>;
```

In `run()`, replace the current top of the function (the `ordinal`/`runId`/`threadId` consts and the `createUIMessageStream({onError, execute})` call) with:

```ts
  function run(input: RunInput): ReadableStream<UIMessageChunk> {
    const ordinal = ++runCounter;
    const runId = `run-${ordinal}`;
    const threadId = input.threadId ?? `thread-${ordinal}`;
    // Hoisted so `onFinish` (a SIBLING of `execute` in the object below, not
    // nested inside it) can read the principal `execute` resolves. Both
    // callbacks close over this one binding; `execute` assigns it before any
    // tool runs, and the stream can't finish before `execute` has started.
    let settledPrincipal: FlowletPrincipal = { userId: "" };

    return createUIMessageStream<FlowletUIMessage>({
      // Route execute failures (bad prompt, provider/Composio errors) into the
      // stream as an error part instead of an unhandled rejection — one crashed
      // run must never take the host process down with it.
      onError: (error) => {
        console.error(`[flowlet] run ${runId} failed:`, error);
        return error instanceof Error ? error.message : "The agent run failed.";
      },
      // ENG-193 §6.2: persistence for the consent endpoint's "load the
      // thread's messages" step. A throwing/rejecting hook is caught here,
      // never surfaced to the model or the client stream.
      onFinish: ({ messages }) => {
        if (!config.onSettled) return;
        Promise.resolve(config.onSettled(messages, settledPrincipal)).catch((err) =>
          console.error(`[flowlet] onSettled failed for run ${runId}:`, err),
        );
      },
      execute: async ({ writer }) => {
        // 1. Resolve the principal. A missing/empty userId fails Composio closed
        //    (no external tools) — the safe default.
        const candidate = input.principal as FlowletPrincipal | undefined;
        const principal: FlowletPrincipal =
          candidate &&
          typeof candidate.userId === "string" &&
          candidate.userId.length > 0
            ? candidate
            : { userId: "" };
        settledPrincipal = principal;
```

(The rest of `execute`'s body — steps 2–7, the Composio ingestion, `sources`, `streamText`, `writer.merge(...)` — is UNCHANGED except for step 5's `buildToolset` call, which gains two members:)

```ts
        // 5. Merge + uniformly policy-wrap every tool.
        const tools = buildToolset({
          sources,
          policy: config.policy,
          principal,
          threadId,
          writer,
          onCollision: (name, kept, dropped) =>
            console.warn(
              `[flowlet] tool "${name}" from source "${dropped}" dropped: ` +
                `name already claimed by higher-precedence source "${kept}".`,
            ),
          onSkip: (name, source, reason) =>
            console.warn(
              `[flowlet] tool "${name}" from source "${source}" skipped: ${reason}`,
            ),
        });
```

And the `messageMetadata` callback inside the final `writer.merge(result.toUIMessageStream({...}))` call keeps using the same `threadId`/`runId` names it does today (`threadId` now resolves to `input.threadId` when the caller supplied one, per the `const threadId = ...` line above) — no change needed there.

- [ ] **Step 5: Run — PASS. Whole package + `pnpm typecheck` — PASS.**

- [ ] **Step 6: Commit** — `feat(runtime): engine threads writer/threadId to the toolset + onSettled persistence hook (ENG-193 §4.3/§6.2)`

---

### Task 4: `handleConsent` — the server-validated grant-creation endpoint

**Files:**
- Create: `packages/flowlet-runtime/src/consent.ts`
- Test: `packages/flowlet-runtime/src/consent.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { handleConsent } from "./consent";
import { createInMemoryGrantStore } from "./grant-store";
import { InMemoryAuditLog, InMemoryThreadStore } from "./embedded/in-memory-store";
import type { ToolDescriptor } from "./descriptor";
import type { FlowletUIMessage } from "@flowlet/core";

const scope = { tenantId: "t", subject: "u" };
const now = () => "2026-07-04T00:00:00Z";

function threadWith(part: Record<string, unknown>): FlowletUIMessage[] {
  return [
    { id: "m1", role: "assistant", parts: [
      { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "call-1", state: "approval-requested",
        input: { to: "acme@example.com" }, approval: { id: "ap-1" }, ...part },
    ] } as unknown as FlowletUIMessage,
  ];
}

function deps(threadMessages: FlowletUIMessage[]) {
  const grants = createInMemoryGrantStore({ now });
  const audit = new InMemoryAuditLog();
  const threads = new InMemoryThreadStore(now);
  return {
    grants, audit, threads,
    resolveDescriptor: (name: string): ToolDescriptor | undefined =>
      name === "GMAIL_SEND_EMAIL"
        ? { name, source: "composio", annotations: {}, hasExecute: true, kind: "function" }
        : name === "transfer_money"
          ? { name, source: "caller", annotations: { destructiveHint: true }, hasExecute: true, kind: "function" }
          : undefined,
    async getMessages() { return threadMessages; },
  };
}

describe("handleConsent", () => {
  it("creates a grant for a yes decision on a matching act-tier approval", async () => {
    const d = deps(threadWith({}));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes",
        grant: { tool: "GMAIL_SEND_EMAIL", scope: { kind: "tool" }, duration: "standing" } },
    });
    expect(result.ok).toBe(true);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(1);
    expect(await d.audit.query(scope, { kinds: ["consent"] })).toHaveLength(1);
  });

  it("403s a critical tool even with a grant draft — the manager's own refusal surfaces", async () => {
    const d = deps(threadWith({ type: "tool-transfer_money", input: {} }));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "transfer_money",
      response: { id: "call-1", decision: "yes",
        grant: { tool: "transfer_money", scope: { kind: "tool" }, duration: "standing" } },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  it("no grant is created for a 'no' decision", async () => {
    const d = deps(threadWith({}));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "no" },
    });
    expect(result.ok).toBe(true);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(0);
    expect(await d.audit.query(scope, { kinds: ["consent"] })).toHaveLength(1);
  });

  it("400s when the tool name doesn't match the pending part's tool", async () => {
    const d = deps(threadWith({}));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "some_other_tool",
      response: { id: "call-1", decision: "yes" },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it("404s when no approval-requested part with that toolCallId exists", async () => {
    const d = deps([]);
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-missing", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-missing", decision: "yes" },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
  });

  it("no grant is created without a response.grant even on 'yes' — approving once doesn't imply remembering", async () => {
    const d = deps(threadWith({}));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes" },
    });
    expect(result.ok).toBe(true);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — FAIL (module not found).** `pnpm --filter @flowlet/runtime test -- consent.test.ts`

- [ ] **Step 3: Implement `consent.ts`**

```ts
/**
 * `handleConsent` — the server-validated grant-creation endpoint logic
 * (ENG-193 §4.5). A host mounts this behind its own HTTP route; this
 * module is transport-agnostic — no `Request`/`Response` here, so it is
 * testable without a server and portable to any route layer. It has TWO
 * production mounts in this plan: `@flowlet/next`'s catch-all (Task 5, the
 * production path demo-bank runs) and the accounting demo's hand-rolled
 * route (Task 7) — see "Plan deviations" #1.
 *
 * Steps (mirrors the ruling): (a) load the thread's messages via the Store
 * seam, (b) find the approval-requested part with the given toolCallId and
 * confirm its tool name matches, (c) resolve the LIVE descriptor via the
 * caller-supplied resolver (each mount's static-toolset lookup, Tasks 5/6),
 * (d) call `createGrantManager.create` — which self-derives criticality and
 * throws on a critical tool; that throw becomes this function's 403, (e)
 * append a "consent" audit event regardless of outcome (the audit trail
 * records EVERY decision, not just the ones that minted a grant).
 */
import type { AuditLog, ConsentResponse, FlowletUIMessage, GrantStore, Principal } from "@flowlet/core";
import type { ToolDescriptor } from "./descriptor";
import { createGrantManager } from "./grant-manager";

export interface HandleConsentDeps {
  grants: GrantStore;
  audit: AuditLog;
  resolveDescriptor: (toolName: string) => ToolDescriptor | undefined;
  /** Loads the thread's persisted messages (Task 3's onSettled writes them). */
  getMessages: (principal: Principal, threadId: string) => Promise<FlowletUIMessage[]>;
  now?: () => string;
}

export interface HandleConsentRequest {
  threadId: string;
  toolCallId: string;
  toolName: string;
  response: ConsentResponse;
}

export type HandleConsentResult =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404; error: string };

/** Structural view of the ai SDK tool-part shape this reads — matches
 *  `engine.ts`'s own `normalizeHistory` scanning, just keyed by toolCallId. */
interface ApprovalPart {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
}

function findApprovalPart(
  messages: FlowletUIMessage[],
  toolCallId: string,
): ApprovalPart | undefined {
  for (const message of messages) {
    for (const rawPart of message.parts) {
      const part = rawPart as ApprovalPart;
      if (
        part.type.startsWith("tool-") &&
        part.toolCallId === toolCallId &&
        (part.state === "approval-requested" || part.state === "approval-responded")
      ) {
        return part;
      }
    }
  }
  return undefined;
}

export async function handleConsent(
  deps: HandleConsentDeps,
  principal: Principal,
  req: HandleConsentRequest,
): Promise<HandleConsentResult> {
  const messages = await deps.getMessages(principal, req.threadId);
  const part = findApprovalPart(messages, req.toolCallId);
  if (!part) {
    return { ok: false, status: 404, error: `no pending approval for toolCallId "${req.toolCallId}"` };
  }
  const partToolName = part.type.slice("tool-".length);
  if (partToolName !== req.toolName) {
    return {
      ok: false, status: 400,
      error: `toolName "${req.toolName}" does not match the pending part's tool "${partToolName}"`,
    };
  }

  const clock = deps.now ?? (() => new Date().toISOString());
  const manager = createGrantManager({ store: deps.grants, audit: deps.audit, now: clock });

  if (req.response.decision === "yes" && req.response.grant) {
    const descriptor = deps.resolveDescriptor(req.toolName);
    if (!descriptor) {
      return { ok: false, status: 404, error: `unknown tool "${req.toolName}"` };
    }
    try {
      await manager.create(
        principal,
        {
          tool: req.response.grant.tool,
          scope: req.response.grant.scope,
          duration: req.response.grant.duration,
          source: { kind: "chat" },
        },
        descriptor,
      );
    } catch (err) {
      await deps.audit.append({
        at: clock(), principal, kind: "consent",
        consentId: req.response.id, decision: req.response.decision,
      });
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 403, error: message };
    }
  }

  await deps.audit.append({
    at: clock(), principal, kind: "consent",
    consentId: req.response.id, decision: req.response.decision,
  });
  return { ok: true };
}
```

- [ ] **Step 4: Run — PASS. Export `handleConsent` + its types from `packages/flowlet-runtime/src/index.ts`, next to the grant manager exports. Run whole package + `pnpm typecheck` — PASS.**

- [ ] **Step 5: Commit** — `feat(runtime): handleConsent — server-validated grant creation (ENG-193 §4.5)`

---

### Task 5: `@flowlet/next` — store option, production policy stack, consent route, chat persistence

This is the production-path mount (deviation #1/#4): `apps/demo-bank` already runs `createFlowletHandler({ policy: demoPolicy, ... })` and inherits everything below with zero app changes.

**Files:**
- Modify: `packages/flowlet-next/src/options.ts` (add `store` option)
- Create: `packages/flowlet-next/src/policy-stack.ts`
- Create: `packages/flowlet-next/src/threads.ts`
- Create: `packages/flowlet-next/src/consent.ts`
- Modify: `packages/flowlet-next/src/chat.ts` (thread persistence + `threadId` into `run()`)
- Modify: `packages/flowlet-next/src/handler.ts` (`assemble()` + `consent` case in POST)
- Modify: `packages/flowlet-next/src/index.ts` (exports)
- Test: `packages/flowlet-next/src/policy-stack.test.ts`, `packages/flowlet-next/src/consent.test.ts`, `packages/flowlet-next/src/chat.test.ts` (extend)

- [ ] **Step 1: Failing tests**

`policy-stack.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { composeProductionPolicy } from "./policy-stack";
import {
  createInMemoryGrantStore,
  InMemoryAuditLog,
  hashDescriptor,
  type ApprovalPolicy,
  type PolicyContext,
  type ToolDescriptor,
} from "@flowlet/runtime";

const scope = { tenantId: "flowlet-embedded", subject: "u1" };
const actDesc: ToolDescriptor = {
  name: "GMAIL_SEND_EMAIL", source: "composio", annotations: {}, hasExecute: true, kind: "function",
};
const criticalDesc: ToolDescriptor = {
  name: "transfer_money", source: "caller", annotations: { destructiveHint: true }, hasExecute: true, kind: "function",
};
const fixed = (d: "allow" | "approve" | "deny"): ApprovalPolicy => ({ evaluate: () => d });
const ctxFor = (descriptor: ToolDescriptor): PolicyContext => ({
  toolName: descriptor.name, input: {}, descriptor,
  principal: { userId: "u1" },
});

describe("composeProductionPolicy", () => {
  it("a matching grant suppresses a repeat approve on the base layer", async () => {
    const grants = createInMemoryGrantStore();
    await grants.create(scope, {
      tool: actDesc.name, descriptorHash: hashDescriptor(actDesc),
      scope: { kind: "tool" }, duration: "standing", source: { kind: "chat" },
    });
    const policy = composeProductionPolicy(fixed("approve"), {
      grants, audit: new InMemoryAuditLog(),
    });
    expect(await policy.evaluate(ctxFor(actDesc))).toBe("allow");
  });

  it("INVARIANT: never suppresses critical, even with a matching grant", async () => {
    const grants = createInMemoryGrantStore();
    await grants.create(scope, {
      tool: criticalDesc.name, descriptorHash: hashDescriptor(criticalDesc),
      scope: { kind: "tool" }, duration: "standing", source: { kind: "chat" },
    });
    const policy = composeProductionPolicy(fixed("approve"), {
      grants, audit: new InMemoryAuditLog(),
    });
    expect(await policy.evaluate(ctxFor(criticalDesc))).toBe("approve");
  });

  it("audit layer records tool_execution on onExecuted", async () => {
    const audit = new InMemoryAuditLog();
    const policy = composeProductionPolicy(fixed("allow"), {
      grants: createInMemoryGrantStore(), audit, now: () => "2026-07-04T00:00:00Z",
    });
    await policy.onExecuted!({ ...ctxFor(actDesc), toolCallId: "call-1" }, "allow");
    expect(await audit.query(scope, { kinds: ["tool_execution"] })).toHaveLength(1);
  });
});
```

`consent.test.ts` (mirrors `handler.test.ts`'s `req()` helper pattern):

```ts
import { describe, expect, it } from "vitest";
import { handleConsentRoute } from "./consent";
import {
  createInMemoryGrantStore,
  InMemoryAuditLog,
  InMemoryThreadStore,
  buildDescriptor,
} from "@flowlet/runtime";
import { createThreadIndex } from "./threads";

const scope = { tenantId: "flowlet-embedded", subject: "flowlet-default-user" };
const now = () => "2026-07-04T00:00:00Z";

function req(body: unknown): Request {
  return new Request("http://localhost:3000/api/flowlet/consent", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", host: "localhost:3000" },
  });
}

function makeDeps() {
  const grants = createInMemoryGrantStore({ now });
  const audit = new InMemoryAuditLog();
  const threads = new InMemoryThreadStore(now);
  const threadIndex = createThreadIndex(threads);
  return {
    grants, audit, threads, threadIndex,
    resolveDescriptor: (name: string) =>
      name === "GMAIL_SEND_EMAIL" ? buildDescriptor(name, {}, "composio") : undefined,
    principal: scope,
  };
}

describe("handleConsentRoute", () => {
  it("400s a malformed body", async () => {
    const res = await handleConsentRoute(req({ nonsense: true }), makeDeps());
    expect(res.status).toBe(400);
  });

  it("round-trips a yes+grant into a minted grant and a consent audit event", async () => {
    const deps = makeDeps();
    const threadId = await deps.threadIndex.resolve(scope, "chat-1");
    await deps.threads.appendMessages(scope, threadId, [
      { id: "m1", role: "assistant", parts: [
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "call-1", state: "approval-requested",
          input: { to: "a@b.com" }, approval: { id: "ap-1" } },
      ] } as never,
    ]);
    const res = await handleConsentRoute(req({
      id: "chat-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes",
        grant: { tool: "GMAIL_SEND_EMAIL", scope: { kind: "tool" }, duration: "standing" } },
    }), deps);
    expect(res.status).toBe(200);
    expect(await deps.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(1);
    expect(await deps.audit.query(scope, { kinds: ["consent"] })).toHaveLength(1);
  });

  it("404s when no pending approval part exists for the toolCallId", async () => {
    const deps = makeDeps();
    const res = await handleConsentRoute(req({
      id: "chat-1", toolCallId: "call-missing", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-missing", decision: "yes" },
    }), deps);
    expect(res.status).toBe(404);
  });
});
```

Extend `chat.test.ts` (mirror its existing mock-agent fixture):

```ts
it("persists the received turn to the threads store keyed by the client's chat id", async () => {
  // Fixture: deps gain { threads: new InMemoryThreadStore(now), threadIndex: createThreadIndex(threads) }.
  // POST body { id: "chat-9", messages: [userMsg] } with a mock agent whose run()
  // returns a short finished stream. Drain the response body fully, then assert
  // threads.getMessages(scope, await threadIndex.resolve(scope, "chat-9"))
  // contains the user message.
});

it("passes the resolved store thread id into agent.run as threadId", async () => {
  // Fixture: a mock agent capturing its RunInput; assert input.threadId equals
  // the id threadIndex minted for "chat-9".
});
```

Write these as real tests against the file's existing mock-agent scaffolding — extend, don't invent a new harness.

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @flowlet/next test -- policy-stack.test.ts consent.test.ts chat.test.ts`

(If `hashDescriptor`/`InMemoryThreadStore` are not yet exported from `@flowlet/runtime`'s index, add them to `packages/flowlet-runtime/src/index.ts` alongside the existing embedded-store exports — `InMemoryThreadStore` and `InMemoryAuditLog` already are; `hashDescriptor` is exported from `./automations` via the automations barrel — verify with a quick grep before assuming.)

- [ ] **Step 3: Implement `policy-stack.ts`**

```ts
/**
 * The item-1 production policy stack (ENG-193 §4.3/§6.2), applied to whatever
 * BASE policy the host runs — `options.policy ?? defaultFlowletPolicy` (see
 * "Plan deviations" #4: the ruling's `annotationPolicy()` is illustrative;
 * wrapping the host's real base layer is the intent). Order matters only for
 * clarity, not correctness: `composePolicy` is most-restrictive-wins, the
 * audit layer always contributes "allow", and `grantPolicy` refuses to
 * suppress critical by type BEFORE any grant lookup (item-1 invariant §8.1).
 *
 * `contextKey: threadId` (§4.3) keys session/task-duration grants to one
 * conversation; the standing grants item 2 mints ignore it.
 */
import type { AuditLog, GrantStore, Principal } from "@flowlet/core";
import {
  auditPolicy,
  composePolicy,
  grantPolicy,
  type ApprovalPolicy,
  type PolicyContext,
} from "@flowlet/runtime";

export const EMBEDDED_TENANT = "flowlet-embedded";

/** The handler's fixed Principal mapping: one embedded tenant, subject = the
 *  resolved FlowletPrincipal's userId (same scope shape world.ts uses). */
export function principalScope(ctx: PolicyContext): Principal {
  return { tenantId: EMBEDDED_TENANT, subject: ctx.principal.userId };
}

export function composeProductionPolicy(
  base: ApprovalPolicy,
  deps: { grants: GrantStore; audit: AuditLog; now?: () => string },
): ApprovalPolicy {
  return composePolicy(
    auditPolicy(deps.audit, {
      principalScope,
      ...(deps.now ? { now: deps.now } : {}),
    }),
    grantPolicy(base, deps.grants, {
      principalScope,
      contextKey: (ctx) => ctx.threadId,
      ...(deps.now ? { now: deps.now } : {}),
    }),
  );
}
```

- [ ] **Step 4: Implement `threads.ts`**

```ts
/**
 * Client-chat-id → store-thread-id index (ENG-193 §6.2, deviation #2). The
 * ai SDK's DefaultChatTransport sends `{ id: chatId, messages, ... }` on
 * every POST; `ThreadStore.create()` mints its own store-assigned id (seam
 * authorship rule), so a mapping is needed. Lazily creates a ThreadRecord
 * the first time a (principal, chatId) pair is seen.
 */
import type { Principal, ThreadStore } from "@flowlet/core";

export interface ThreadIndex {
  resolve(scope: Principal, clientId: string): Promise<string>;
}

export function createThreadIndex(threads: ThreadStore): ThreadIndex {
  const byClientId = new Map<string, string>();
  return {
    async resolve(scope, clientId) {
      const key = `${scope.tenantId}::${scope.subject}::${clientId}`;
      const existing = byClientId.get(key);
      if (existing) return existing;
      const record = await threads.create(scope, { title: clientId });
      byClientId.set(key, record.id);
      return record.id;
    },
  };
}
```

- [ ] **Step 5: Implement `consent.ts`**

```ts
/**
 * POST /api/flowlet/consent — the handler-side mount of the runtime's
 * `handleConsent` (ENG-193 §4.5). Follows action.ts's conventions: body
 * validation → 400, principal/guard handled by the caller (handler.ts runs
 * `resolvePrincipal` before dispatching here), result statuses pass through.
 */
import { handleConsent } from "@flowlet/runtime";
import type { ToolDescriptor } from "@flowlet/runtime";
import type { AuditLog, GrantStore, Principal, ThreadStore } from "@flowlet/core";
import { consentResponseSchema } from "@flowlet/core";
import type { ThreadIndex } from "./threads";

export interface ConsentRouteDeps {
  grants: GrantStore;
  audit: AuditLog;
  threads: ThreadStore;
  threadIndex: ThreadIndex;
  resolveDescriptor: (toolName: string) => ToolDescriptor | undefined;
  principal: Principal;
}

interface ConsentBody {
  id?: string; // the ai SDK chat id — same body key /chat receives
  toolCallId?: string;
  toolName?: string;
  response?: unknown;
}

export async function handleConsentRoute(req: Request, deps: ConsentRouteDeps): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as ConsentBody;
  const parsedResponse = consentResponseSchema.safeParse(body.response);
  if (
    typeof body.id !== "string" ||
    typeof body.toolCallId !== "string" ||
    typeof body.toolName !== "string" ||
    !parsedResponse.success
  ) {
    return Response.json({ error: "malformed consent request" }, { status: 400 });
  }
  const threadId = await deps.threadIndex.resolve(deps.principal, body.id);
  const result = await handleConsent(
    {
      grants: deps.grants,
      audit: deps.audit,
      resolveDescriptor: deps.resolveDescriptor,
      getMessages: (scope, id) => deps.threads.getMessages(scope, id),
    },
    deps.principal,
    { threadId, toolCallId: body.toolCallId, toolName: body.toolName, response: parsedResponse.data },
  );
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true });
}
```

- [ ] **Step 6: Add the `store` option** (`options.ts`) — add to `FlowletHandlerOptions`:

```ts
  /**
   * Store seam members backing grants, audit, and thread persistence
   * (ENG-193 §6.1/§6.2). Defaults: fresh in-memory instances (reset on
   * process restart). Inject when the host persists these elsewhere.
   */
  store?: { grants?: GrantStore; audit?: AuditLog; threads?: ThreadStore };
```

with the matching import (`import type { AuditLog, GrantStore, ThreadStore } from "@flowlet/core";`) and zod member (mirroring the existing `connections` custom-check style):

```ts
    store: z
      .object({
        grants: z.custom<GrantStore>((v) => typeof v === "object" && v !== null).optional(),
        audit: z.custom<AuditLog>((v) => typeof v === "object" && v !== null).optional(),
        threads: z.custom<ThreadStore>((v) => typeof v === "object" && v !== null).optional(),
      })
      .strict()
      .optional(),
```

- [ ] **Step 7: Wire `handler.ts`** — in `assemble()`, after the `const policy = options.policy ?? defaultFlowletPolicy;` line, replace that line with:

```ts
    const grants = options.store?.grants ?? createInMemoryGrantStore();
    const audit = options.store?.audit ?? new InMemoryAuditLog();
    const threads = options.store?.threads ?? new InMemoryThreadStore(() => new Date().toISOString());
    const threadIndex = createThreadIndex(threads);
    // ENG-193 item 2: the item-1 stack wraps the host's base policy — grants
    // can suppress repeat approvals (never critical), audit records executes.
    const basePolicy = options.policy ?? defaultFlowletPolicy;
    const policy = composeProductionPolicy(basePolicy, { grants, audit });
```

with imports `import { composeProductionPolicy, EMBEDDED_TENANT } from "./policy-stack";`, `import { createThreadIndex } from "./threads";`, `import { handleConsentRoute } from "./consent";`, and `import { createInMemoryGrantStore, InMemoryAuditLog, InMemoryThreadStore, buildDescriptor, hostToolset } from "@flowlet/runtime";` (merge with any existing runtime imports).

Add a descriptor resolver next to `serverTools` (same static-resolution rationale as Task 6's — exact for host tools and server tools whose objects carry annotations, act+unverified for Composio names, which carry no annotations on this path; even if a live Composio descriptor ever differed, `grantPolicy` re-checks the LIVE tier before suppressing, so a mis-minted grant can never fire on a critical tool — item-1 invariant):

```ts
    const clientTools = hostToolset(hostTools);
    const resolveDescriptor = (toolName: string) => {
      const client = clientTools[toolName];
      if (client) return buildDescriptor(toolName, client, "caller");
      const server = serverTools()[toolName];
      if (server) return buildDescriptor(toolName, server, "engine");
      if (/^[A-Z]+_[A-Z_]+$/.test(toolName)) return buildDescriptor(toolName, {}, "composio");
      return undefined;
    };
```

Extend the returned object with `grants, audit, threads, threadIndex, resolveDescriptor` and add the POST case (after `case "action"`):

```ts
      case "consent": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return handleConsentRoute(req, {
          grants: s.grants,
          audit: s.audit,
          threads: s.threads,
          threadIndex: s.threadIndex,
          resolveDescriptor: s.resolveDescriptor,
          principal: { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId },
        });
      }
```

Update the handler's endpoint doc comment (top of file) to list `POST /consent — answers a ConsentRequest; server-validates grant creation (ENG-193)`.

- [ ] **Step 8: Wire persistence + threadId into `chat.ts`** — `ChatDeps` gains `threads: ThreadStore` and `threadIndex: ThreadIndex`; `ChatRequestBody` gains `id?: string`; after the messages validation:

```ts
  const clientThreadId = typeof body.id === "string" && body.id.length > 0 ? body.id : "default";
  const scope: Principal = { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId };
  const threadRecordId = await deps.threadIndex.resolve(scope, clientThreadId);
```

pass `threadId: threadRecordId` into `deps.getAgent().run({...})`, and persist the received-history delta after `createUIMessageStreamResponse` is constructed but before returning (fire-and-forget, errors logged — identical shape to Task 6's accounting version):

```ts
  void (async () => {
    try {
      const existing = await deps.threads.getMessages(scope, threadRecordId);
      const toAppend = messages.slice(existing.length);
      if (toAppend.length > 0) {
        await deps.threads.appendMessages(scope, threadRecordId, toAppend);
      }
    } catch (err) {
      console.error("[flowlet] thread persistence failed:", err);
    }
  })();
```

(Persisting what the client SENT — not the streamed tail — is deliberate and sufficient: the client resends full history every turn, so by the time a consent POST for turn N's approval card arrives, turn N's approval-requested part has already been received in the POST /chat body that produced the card's stream. The tee-and-drain variant in Task 6 exists because the accounting handler had already adopted it; both converge on the same store contents.)

Handler.ts's `POST` chat case passes the two new deps: `threads: s.threads, threadIndex: s.threadIndex`.

- [ ] **Step 9: Exports** — add to `packages/flowlet-next/src/index.ts`:

```ts
export { composeProductionPolicy, principalScope, EMBEDDED_TENANT } from "./policy-stack";
export { createThreadIndex, type ThreadIndex } from "./threads";
export { handleConsentRoute, type ConsentRouteDeps } from "./consent";
```

- [ ] **Step 10: Run — all three test files PASS; whole package (`pnpm --filter @flowlet/next test`) + `pnpm typecheck` PASS.** demo-bank needs no change (its route already injects `policy: demoPolicy`, now auto-wrapped); confirm `pnpm --filter demo-bank test` still passes.

- [ ] **Step 11: Commit** — `feat(next): consent route + production policy stack (grants/audit/threads) in createFlowletHandler (ENG-193 §4.5/§6)`

---

### Task 6: Accounting demo — Store wiring, thread persistence, tool-descriptor resolver

This is the hand-rolled-path parallel of Task 5, kept because the accounting demo is the verification host and is NOT migrated to `@flowlet/next` (deviations #1/#5).

**Files:**
- Create: `apps/demo-accounting/src/flowlet/store.ts`
- Create: `apps/demo-accounting/src/flowlet/tool-registry.ts`
- Modify: `apps/demo-accounting/src/flowlet/chat-handler.ts`
- Test: `apps/demo-accounting/src/flowlet/store.test.ts`, `apps/demo-accounting/src/flowlet/tool-registry.test.ts`, `apps/demo-accounting/src/flowlet/chat-handler.test.ts` (extend)

- [ ] **Step 1: Failing tests**

`store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { demoStore, resolveThreadRecordId } from "./store";
import { CADENCE_SCOPE } from "./automations";

describe("demo store + thread id mapping", () => {
  it("has grants and audit wired (item-1 primitives)", async () => {
    expect(demoStore.grants).toBeDefined();
    expect(demoStore.audit).toBeDefined();
  });

  it("maps a client-stable thread id to a store-assigned ThreadRecord id, stably", async () => {
    const a = await resolveThreadRecordId(CADENCE_SCOPE, "cadence-demo");
    const b = await resolveThreadRecordId(CADENCE_SCOPE, "cadence-demo");
    expect(a).toBe(b);
    const other = await resolveThreadRecordId(CADENCE_SCOPE, "other-thread");
    expect(other).not.toBe(a);
  });
});
```

`tool-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveToolDescriptor } from "./tool-registry";
import { dangerTier, isUnverified } from "@flowlet/runtime";

describe("resolveToolDescriptor", () => {
  it("Cadence host tools carry their real OpenAPI-derived annotations", () => {
    const d = resolveToolDescriptor("sendClientMessage");
    expect(d).toBeDefined();
    expect(dangerTier(d!)).toBe("act");
  });

  it("automation-authoring critical tools resolve as critical", () => {
    const d = resolveToolDescriptor("create_automation");
    expect(d).toBeDefined();
    expect(dangerTier(d!)).toBe("critical");
  });

  it("Composio-ingested tools resolve act+unverified (no live schema fetch needed for tier purposes)", () => {
    const d = resolveToolDescriptor("GMAIL_SEND_EMAIL");
    expect(d).toBeDefined();
    expect(dangerTier(d!)).toBe("act");
    expect(isUnverified(d!)).toBe(true);
  });

  it("unknown tool name resolves undefined", () => {
    expect(resolveToolDescriptor("not_a_real_tool")).toBeUndefined();
  });
});
```

Extend `chat-handler.test.ts` with:

```ts
it("persists the turn's messages to the demo store keyed by the client's chat id", async () => {
  // Fixture: a mock FlowletAgent whose run() emits a `start` chunk with
  // metadata + a couple of parts, then finishes. POST { id: "conv-x", messages }.
  // After the response settles, assert demoStore.threads.getMessages(CADENCE_SCOPE, <mapped id>)
  // returns a non-empty array (via resolveThreadRecordId(CADENCE_SCOPE, "conv-x")).
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm --filter demo-accounting test -- store.test.ts tool-registry.test.ts chat-handler.test.ts`

- [ ] **Step 3: Implement `store.ts`**

```ts
/**
 * The Cadence demo's Store seam wiring (ENG-193 §6.1/§6.2) — the hand-rolled
 * parallel of what `createFlowletHandler` assembles for `@flowlet/next` hosts
 * (packages/flowlet-next/src/handler.ts); this app hasn't migrated to the
 * handler, so it wires the same in-memory primitives directly.
 *
 * `ThreadStore.create()` mints its own store-assigned id (a deliberate seam
 * rule); the client's stable chat id ("cadence-demo", see FlowletRoot.tsx)
 * is a friendly string, not that id. `resolveThreadRecordId` lazily creates a
 * ThreadRecord the first time a client id is seen and remembers the mapping —
 * same "single-slot cache, rebuilt on demo reset" idea already used for the
 * agent cache in `app/api/flowlet/chat/route.ts`.
 */
import { createInMemoryGrantStore, createInMemoryStore, type InMemoryStore } from "@flowlet/runtime";
import type { GrantStore, Principal } from "@flowlet/core";
import { CADENCE_SCOPE } from "./automations";

export interface DemoStore extends InMemoryStore {
  grants: GrantStore;
}

export const demoStore: DemoStore = {
  ...createInMemoryStore(),
  grants: createInMemoryGrantStore(),
};

const threadIdByClientId = new Map<string, string>();

/** Resolve (creating on first sight) the store-assigned ThreadRecord id for a
 *  client-stable chat id, scoped by principal. */
export async function resolveThreadRecordId(scope: Principal, clientId: string): Promise<string> {
  const key = `${scope.tenantId}::${scope.subject}::${clientId}`;
  const existing = threadIdByClientId.get(key);
  if (existing) return existing;
  const record = await demoStore.threads.create(scope, { title: clientId });
  threadIdByClientId.set(key, record.id);
  return record.id;
}

/** Reset hook for the demo's `Cmd/Ctrl+Shift+.` reseed — clears the mapping so
 *  a reset thread doesn't inherit stale message history. */
export function resetThreadMapping(): void {
  threadIdByClientId.clear();
}

// Re-export for callers that only need the fixed demo principal scope.
export { CADENCE_SCOPE };
```

- [ ] **Step 4: Implement `tool-registry.ts`**

```ts
/**
 * Static, synchronous tool-descriptor resolution for the consent endpoint
 * (ENG-193 §4.5 ruling (c): "resolve the LIVE descriptor from the engine's
 * registered toolset"). The engine itself only assembles a toolset inside a
 * `run()` closure (no standalone lookup exists) — but every tool this demo
 * ever gates is one of three known, statically-describable sources, so this
 * resolver rebuilds descriptors the SAME way `buildDescriptor` would without
 * needing a live model turn or a Composio network round-trip:
 *
 * - Cadence's own host tools: real annotations already computed by
 *   `openApiToHostTools` from the OpenAPI spec (host-tools.ts) — exact.
 * - Automation-authoring tools: their tool objects carry `annotations`
 *   directly (`createAutomationTools`, `destructiveHint: true` for
 *   create/update/delete) — `buildDescriptor` reads that straight off the
 *   object — exact.
 * - Composio-ingested tools (GMAIL_*/GOOGLECALENDAR_*): this app never
 *   attaches real MCP annotations to these (confirmed: `policy.ts`'s
 *   `namePolicy` decides them by verb-segment matching, not by descriptor).
 *   `buildDescriptor` with no explicit annotations therefore correctly
 *   resolves them to tier "act" + unverified (Yousef's own ruling for
 *   unknown-annotation tools) — this is accurate, not a workaround.
 */
import { buildDescriptor, hostToolset, type ToolDescriptor } from "@flowlet/runtime";
import { cadenceHostToolDefs } from "./host-tools";
import { automationsWorld } from "./automations";

const hostTools = hostToolset(cadenceHostToolDefs);

export function resolveToolDescriptor(toolName: string): ToolDescriptor | undefined {
  const host = hostTools[toolName];
  if (host) return buildDescriptor(toolName, host, "caller");

  const authoring = automationsWorld().authoringTools()[toolName];
  if (authoring) return buildDescriptor(toolName, authoring, "engine");

  // Composio-ingested tools: no static tool object exists to introspect (the
  // real schema is fetched per-principal at chat time), but the ANNOTATIONS
  // are always empty in this app regardless — so building a descriptor with
  // no explicit annotations produces the same tier/unverified result the live
  // one would.
  if (/^[A-Z]+_[A-Z_]+$/.test(toolName)) {
    return buildDescriptor(toolName, {}, "composio");
  }
  return undefined;
}
```

- [ ] **Step 5: Wire persistence into `chat-handler.ts`** — extend `ChatRequestBody`, resolve the thread id, and pass an `onSettled`-driven agent (the agent itself is built once per generation in `route.ts`'s `getAgent()`; `onSettled` needs the resolved threadId, which is per-request — thread it through `RunInput.threadId` and let `agent.run`'s `onSettled` receive it via closure isn't possible since `onSettled` is fixed at `createFlowletAgent` construction time, not per-run. **Resolution:** `handleChat` wraps persistence itself, outside the agent, using the SAME `onFinish`-shaped hook by tapping the returned stream instead of relying on `FlowletAgentConfig.onSettled` for this one call site — simpler and keeps `createDemoAgent` a pure, cacheable singleton per generation):

```ts
import { createUIMessageStreamResponse } from "ai";
import type { FlowletAgent, FlowletUIMessage } from "@flowlet/core";
import { hostToolset } from "@flowlet/runtime";
import { DEMO_PRINCIPAL } from "./principal";
import { cadenceHostToolDefs } from "./host-tools";
import { demoPrincipalAllowed, LOCAL_ONLY_MESSAGE } from "./local-guard";
import { demoStore, resolveThreadRecordId, CADENCE_SCOPE } from "./store";

interface ChatRequestBody {
  /** The ai SDK Chat's own id (DefaultChatTransport's default body key — see
   *  "Plan deviations" #2). Falls back to a fixed thread when a caller
   *  (tests, an older client) omits it. */
  id?: string;
  messages?: FlowletUIMessage[];
}

export async function handleChat(req: Request, agent: FlowletAgent): Promise<Response> {
  if (!demoPrincipalAllowed(req)) {
    return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as ChatRequestBody;
  const messages = body.messages ?? [];
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "messages must be a non-empty array" }, { status: 400 });
  }
  const clientThreadId = body.id ?? "cadence-demo";
  const threadRecordId = await resolveThreadRecordId(CADENCE_SCOPE, clientThreadId);

  const stream = agent.run({
    messages,
    tools: hostToolset(cadenceHostToolDefs),
    principal: DEMO_PRINCIPAL,
    signal: req.signal,
    threadId: threadRecordId,
  });

  // Persist the tail of the stream once it settles (ENG-193 §6.2 — the
  // consent endpoint reads this via the Store seam). Only NEW messages beyond
  // what's already stored are appended — the client resends the full history
  // every turn, so `appendMessages` (append-only by contract) would otherwise
  // duplicate every prior turn.
  const [forClient, forStore] = stream.tee();
  void (async () => {
    try {
      const reader = forStore.getReader();
      // Draining the tee'd branch is enough to let the response side finish
      // independently; the FULL final message list needed for persistence
      // isn't reconstructable from raw chunks here, so persist the CLIENT'S
      // OWN latest turn (what it sent us) plus nothing else — the next turn's
      // `messages` array is the source of truth for anything the model added,
      // since the client always resends full history. Persist what we RECEIVED,
      // which already contains every prior assistant turn once the client's
      // next request lands.
      while (!(await reader.read()).done) {
        /* drain only */
      }
      const existing = await demoStore.threads.getMessages(CADENCE_SCOPE, threadRecordId);
      const toAppend = messages.slice(existing.length);
      if (toAppend.length > 0) {
        await demoStore.threads.appendMessages(CADENCE_SCOPE, threadRecordId, toAppend);
      }
    } catch (err) {
      console.error("[flowlet] thread persistence failed:", err);
    }
  })();

  return createUIMessageStreamResponse({ stream: forClient });
}
```

- [ ] **Step 6: Run all three test files — PASS. Whole app test suite (`pnpm --filter demo-accounting test`) + `pnpm typecheck` — PASS.**

- [ ] **Step 7: Commit** — `feat(demo-accounting): wire grants/audit Store + thread persistence + tool-descriptor resolver (ENG-193 §6)`

---

### Task 7: Accounting demo — mount the consent route, compose the full policy stack

**Files:**
- Modify: `apps/demo-accounting/src/flowlet/policy.ts`
- Create: `apps/demo-accounting/src/app/api/flowlet/consent/route.ts`
- Create: `apps/demo-accounting/src/flowlet/consent-handler.ts`
- Test: `apps/demo-accounting/src/flowlet/policy.test.ts` (extend), `apps/demo-accounting/src/flowlet/consent-handler.test.ts`

- [ ] **Step 1: Failing tests**

Extend `policy.test.ts`:

```ts
it("a matching grant suppresses a repeat act-tier approve, but never a critical one", async () => {
  // Seed demoStore.grants with a tool-scope grant for GMAIL_SEND_EMAIL via
  // demoStore.grants.create(CADENCE_SCOPE, {...}), matching descriptorHash
  // from resolveToolDescriptor("GMAIL_SEND_EMAIL"). Evaluate demoPolicy with a
  // ctx for that tool -> expect "allow". Evaluate with a destructiveHint:true
  // descriptor + a grant seeded for it too -> still "approve".
});
```

New `consent-handler.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { handleDemoConsent } from "./consent-handler";
import { demoStore, resolveThreadRecordId, CADENCE_SCOPE } from "./store";

function req(body: unknown): Request {
  return new Request("http://localhost/api/flowlet/consent", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", host: "localhost" },
  });
}

describe("handleDemoConsent", () => {
  it("400s a malformed body", async () => {
    const res = await handleDemoConsent(req({ nonsense: true }));
    expect(res.status).toBe(400);
  });

  it("round-trips a real approval into a grant", async () => {
    const threadId = await resolveThreadRecordId(CADENCE_SCOPE, "test-thread-1");
    await demoStore.threads.appendMessages(CADENCE_SCOPE, threadId, [
      { id: "m1", role: "assistant", parts: [
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "call-9", state: "approval-requested",
          input: { to: "acme@example.com" }, approval: { id: "ap-9" } },
      ] } as never,
    ]);
    const res = await handleDemoConsent(req({
      id: "test-thread-1", toolCallId: "call-9", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-9", decision: "yes",
        grant: { tool: "GMAIL_SEND_EMAIL", scope: { kind: "tool" }, duration: "standing" } },
    }));
    expect(res.status).toBe(200);
    expect(await demoStore.grants.findForTool(CADENCE_SCOPE, "GMAIL_SEND_EMAIL")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm --filter demo-accounting test -- policy.test.ts consent-handler.test.ts`

- [ ] **Step 3: Rewrite `policy.ts`'s exported stack** (keep `namePolicy` exactly as-is — only the final export changes, per "Plan deviations" #4):

```ts
import { annotationPolicy, auditPolicy, composePolicy, grantPolicy, type ApprovalPolicy } from "@flowlet/runtime";
import { READ_ONLY_TOOLS } from "./tools";
import { demoStore, CADENCE_SCOPE } from "./store";

// ... ALWAYS_ALLOW / READ_VERBS / WRITE_VERBS / hostAnnotations / namePolicy: unchanged ...

/**
 * ENG-193 item 2: compose the item-1 primitives onto the app's real base
 * decision layer (see "Plan deviations" #4 — the ruling's `annotationPolicy()`
 * snippet is illustrative; this app's actual base layer is `namePolicy`,
 * which already calls `annotationPolicy()` for client-executed tools and does
 * verb-based decisions for everything else). `contextKey: threadId` (§4.3)
 * lets a fade/session grant (later items) match within one conversation;
 * standing grants (the only kind item 2 creates) ignore it.
 */
export const demoPolicy: ApprovalPolicy = composePolicy(
  auditPolicy(demoStore.audit, { principalScope: () => CADENCE_SCOPE }),
  grantPolicy(namePolicy, demoStore.grants, {
    principalScope: () => CADENCE_SCOPE,
    contextKey: (ctx) => ctx.threadId,
  }),
);
```

- [ ] **Step 4: Implement `consent-handler.ts`**

```ts
/**
 * POST /api/flowlet/consent — mounts `handleConsent` (ENG-193 §4.5) behind
 * this app's own hand-rolled route, the same way every other Flowlet route
 * here is a thin adapter over a testable handler function (see
 * chat-handler.ts/action-handler.ts). The `@flowlet/next` production mount of
 * the SAME runtime logic lives in packages/flowlet-next/src/consent.ts; this
 * app hasn't migrated to the handler ("Plan deviations" #1).
 */
import { handleConsent, type HandleConsentRequest } from "@flowlet/runtime";
import { consentResponseSchema } from "@flowlet/core";
import { demoStore, resolveThreadRecordId, CADENCE_SCOPE } from "./store";
import { resolveToolDescriptor } from "./tool-registry";
import { demoPrincipalAllowed, LOCAL_ONLY_MESSAGE } from "./local-guard";

interface ConsentBody {
  id?: string; // client chat/thread id, same field chat-handler reads
  toolCallId?: string;
  toolName?: string;
  response?: unknown;
}

export async function handleDemoConsent(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) {
    return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as ConsentBody;
  const parsedResponse = consentResponseSchema.safeParse(body.response);
  if (
    typeof body.id !== "string" ||
    typeof body.toolCallId !== "string" ||
    typeof body.toolName !== "string" ||
    !parsedResponse.success
  ) {
    return Response.json({ error: "malformed consent request" }, { status: 400 });
  }
  const threadId = await resolveThreadRecordId(CADENCE_SCOPE, body.id);
  const consentReq: HandleConsentRequest = {
    threadId, toolCallId: body.toolCallId, toolName: body.toolName, response: parsedResponse.data,
  };
  const result = await handleConsent(
    {
      grants: demoStore.grants,
      audit: demoStore.audit,
      resolveDescriptor: resolveToolDescriptor,
      getMessages: (scope, id) => demoStore.threads.getMessages(scope, id),
    },
    CADENCE_SCOPE,
    consentReq,
  );
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true });
}
```

- [ ] **Step 5: Create the route** — `apps/demo-accounting/src/app/api/flowlet/consent/route.ts`:

```ts
/** POST /api/flowlet/consent — see consent-handler.ts. */
import { handleDemoConsent } from "@/flowlet/consent-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleDemoConsent(req);
}
```

- [ ] **Step 6: Run — PASS. Whole app suite + `pnpm typecheck` — PASS.**

- [ ] **Step 7: Commit** — `feat(demo-accounting): mount the consent route, compose grantPolicy+auditPolicy (ENG-193 §4.5/§6)`

---

**— Yousef UI-review checkpoint before Task 8 —** Everything above is engine/server plumbing (no UI). Tasks 8–12 touch the shell's rendered cards. Per CLAUDE.md's standing rule, pause here and confirm the card/receipt/batch treatment described in Tasks 8–12 before building it.

---

### Task 8: Shell data plumbing — `ThreadItem` gains tier/unverified/toolCallId, batching

**Files:**
- Modify: `packages/flowlet-shell/src/use-flowlet-thread.ts`
- Test: `packages/flowlet-shell/src/use-flowlet-thread.test.ts` (extend/create — check for an existing file first; if none exists, mirror `message-list.test.tsx`'s import style for a new one)

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { groupThreadItems, toThreadItems } from "./use-flowlet-thread";
import type { FlowletUIMessage } from "@flowlet/core";

function msg(parts: unknown[]): FlowletUIMessage {
  return { id: "m1", role: "assistant", parts } as unknown as FlowletUIMessage;
}

describe("toThreadItems — consent tier correlation", () => {
  it("attaches tier/unverified/toolCallId to an approval item from its sibling data-consent part", () => {
    const items = toThreadItems([
      msg([
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "call-1", state: "approval-requested",
          input: { to: "a@b.com" }, approval: { id: "ap-1" } },
        { type: "data-consent", data: { toolCallId: "call-1", tier: "act", unverified: true } },
      ]),
    ]);
    const approval = items.find((i) => i.kind === "approval");
    expect(approval).toMatchObject({ toolCallId: "call-1", tier: "act", unverified: true });
  });

  it("an approval with no matching data-consent part gets no tier (defensive — never crashes)", () => {
    const items = toThreadItems([
      msg([{ type: "tool-x", toolCallId: "call-2", state: "approval-requested", input: {}, approval: { id: "ap-2" } }]),
    ]);
    const approval = items.find((i) => i.kind === "approval");
    expect(approval).toMatchObject({ toolCallId: "call-2" });
    expect((approval as { tier?: string }).tier).toBeUndefined();
  });

  it("a settled tool item also carries tier from its data-consent part (receipts)", () => {
    const items = toThreadItems([
      msg([
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "call-3", state: "output-available", input: { to: "a@b.com" }, output: "sent" },
        { type: "data-consent", data: { toolCallId: "call-3", tier: "act", unverified: false } },
      ]),
    ]);
    const tool = items.find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ tier: "act" });
  });
});

describe("groupThreadItems — batching sibling approvals", () => {
  it("groups 2+ approval-requested items of the SAME tool in the SAME message into one approval-batch", () => {
    const items = toThreadItems([
      msg([
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c1", state: "approval-requested", input: { to: "a@b.com" }, approval: { id: "ap1" } },
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c2", state: "approval-requested", input: { to: "c@d.com" }, approval: { id: "ap2" } },
      ]),
    ]);
    const grouped = groupThreadItems(items);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ kind: "approval-batch", toolName: "GMAIL_SEND_EMAIL" });
    expect((grouped[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it("does NOT batch a single approval, or approvals of DIFFERENT tools", () => {
    const items = toThreadItems([
      msg([
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c1", state: "approval-requested", input: {}, approval: { id: "ap1" } },
        { type: "tool-GOOGLECALENDAR_CREATE_EVENT", toolCallId: "c2", state: "approval-requested", input: {}, approval: { id: "ap2" } },
      ]),
    ]);
    const grouped = groupThreadItems(items);
    expect(grouped.every((g) => g.kind !== "approval-batch")).toBe(true);
  });
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @flowlet/shell test -- use-flowlet-thread.test.ts`

- [ ] **Step 3: Implement**

Change the `"approval"` and `"tool"` members of the `ThreadItem` union:

```ts
export type ThreadItem =
  | { kind: "text"; key: string; messageId: string; role: "user" | "assistant"; text: string }
  | { kind: "file"; key: string; messageId: string; role: "user" | "assistant"; mediaType: string; filename?: string; url: string }
  | {
      kind: "tool";
      key: string;
      messageId: string;
      toolName: string;
      toolCallId?: string;
      state: string;
      input?: unknown;
      output?: unknown;
      errorText?: string;
      /** From the sibling data-consent part (ENG-193 §4.1/§4.5). Absent for
       *  read-tier calls and for messages from before this shipped. */
      tier?: "act" | "critical";
      unverified?: boolean;
    }
  | {
      kind: "approval";
      key: string;
      messageId: string;
      approvalId: string;
      toolCallId?: string;
      toolName: string;
      input: unknown;
      tier?: "act" | "critical";
      unverified?: boolean;
    }
  | { kind: "ui"; key: string; messageId: string; node: UINode }
  | { kind: "skeleton"; key: string; messageId: string; name?: string }
  | { kind: "error"; key: string; messageId: string; message: string };
```

Change `RenderItem` to add the batch variant:

```ts
export type RenderItem =
  | ThreadItem
  | { kind: "activity"; key: string; messageId: string; steps: ToolItem[] }
  | { kind: "approval-batch"; key: string; messageId: string; toolName: string; items: Extract<ThreadItem, { kind: "approval" }>[] };
```

Rewrite `toThreadItems` to do a first pass collecting `data-consent` parts by toolCallId, then use that map on both the `approval` and `tool` branches:

```ts
export function toThreadItems(messages: FlowletUIMessage[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const message of messages) {
    const role = message.role === "user" ? "user" : "assistant";
    const messageId = message.id;
    // First pass: index this message's data-consent parts by toolCallId
    // (ENG-193 §4.5) — a tool part and its tier metadata can arrive in either
    // order within the same message, so both branches below read this map
    // rather than assuming ordering.
    const tierByToolCallId = new Map<string, { tier: "act" | "critical"; unverified: boolean }>();
    for (const rawPart of message.parts) {
      const part = rawPart as { type: string; data?: { toolCallId?: string; tier?: string; unverified?: boolean } };
      if (part.type === "data-consent" && part.data?.toolCallId) {
        tierByToolCallId.set(part.data.toolCallId, {
          tier: part.data.tier as "act" | "critical",
          unverified: Boolean(part.data.unverified),
        });
      }
    }
    message.parts.forEach((rawPart, index) => {
      const part = rawPart as { type: string; [k: string]: unknown };
      const key = `${message.id}:${index}`;
      if (part.type === "text") {
        items.push({ kind: "text", key, messageId, role, text: String(part.text ?? "") });
      } else if (part.type === "file") {
        items.push({
          kind: "file", key, messageId, role,
          mediaType: String(part.mediaType ?? "application/octet-stream"),
          filename: part.filename as string | undefined, url: String(part.url ?? ""),
        });
      } else if (part.type === "error") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = part as any;
        items.push({ kind: "error", key, messageId, message: String(p.errorText ?? p.error ?? "Something went wrong") });
      } else if (part.type === "data-ui") {
        items.push({ kind: "ui", key, messageId, node: part.data as UINode });
      } else if (part.type === "data-consent") {
        // Consumed via tierByToolCallId above — never its own render item.
      } else if (part.type.startsWith("tool-")) {
        const toolName = part.type.slice("tool-".length);
        const toolCallId = part.toolCallId as string | undefined;
        const tierInfo = toolCallId ? tierByToolCallId.get(toolCallId) : undefined;
        if (part.state === "approval-requested") {
          const approval = part.approval as { id: string };
          items.push({
            kind: "approval", key, messageId, approvalId: approval.id, toolCallId, toolName, input: part.input,
            tier: tierInfo?.tier, unverified: tierInfo?.unverified,
          });
        } else if (RENDER_TOOLS.has(toolName)) {
          const state = String(part.state ?? "");
          if (toolName === "render_view" && (state === "input-streaming" || state === "input-available")) {
            items.push({ kind: "skeleton", key, messageId, name: renderName(part.input) });
          } else if (state === "output-error") {
            items.push({ kind: "error", key, messageId, message: String(part.errorText ?? "Failed to render UI") });
          }
        } else {
          items.push({
            kind: "tool", key, messageId, toolName, toolCallId, state: String(part.state ?? ""),
            input: part.input, output: part.output, errorText: part.errorText as string | undefined,
            tier: tierInfo?.tier, unverified: tierInfo?.unverified,
          });
        }
      }
    });
  }
  return items;
}
```

Rewrite `groupThreadItems` to batch sibling approvals of the same tool in the same message BEFORE the existing tool-grouping pass (approvals and tool-results never mix, so the two passes are independent):

```ts
export function groupThreadItems(items: ThreadItem[]): RenderItem[] {
  const out: RenderItem[] = [];
  const groupIndexByMessage = new Map<string, number>();
  // key = `${messageId}::${toolName}` -> index into `out` of its approval-batch
  const approvalGroupIndex = new Map<string, number>();

  for (const item of items) {
    if (item.kind === "tool") {
      const existing = groupIndexByMessage.get(item.messageId);
      if (existing !== undefined) {
        (out[existing] as { steps: ToolItem[] }).steps.push(item);
      } else {
        groupIndexByMessage.set(item.messageId, out.length);
        out.push({ kind: "activity", key: `activity:${item.messageId}`, messageId: item.messageId, steps: [item] });
      }
    } else if (item.kind === "approval") {
      const groupKey = `${item.messageId}::${item.toolName}`;
      const existing = approvalGroupIndex.get(groupKey);
      if (existing !== undefined) {
        const group = out[existing] as { kind: string; items?: typeof item[] };
        if (group.kind === "approval-batch") {
          group.items!.push(item);
          continue;
        }
      }
      // First sighting: hold a place. It gets promoted to a real
      // "approval-batch" only if a SECOND sibling of the same tool shows up
      // (below) — a lone approval stays a plain "approval" render item so
      // ApprovalCard (not ApprovalBatchCard) renders it, unchanged from today.
      approvalGroupIndex.set(groupKey, out.length);
      out.push(item);
    } else {
      out.push(item);
    }
  }

  // Second pass: promote any placeholder that gained siblings into a real
  // "approval-batch" — done as a pass rather than inline above so a batch's
  // FIRST item (already pushed as a plain "approval") converts cleanly once
  // its second sibling is seen, without special-casing index 0 vs index 1+.
  for (const [groupKey, index] of approvalGroupIndex) {
    const entry = out[index];
    if (entry && entry.kind === "approval") {
      const toolName = groupKey.slice(groupKey.indexOf("::") + 2);
      const siblings = items.filter(
        (i): i is Extract<ThreadItem, { kind: "approval" }> =>
          i.kind === "approval" && i.messageId === entry.messageId && i.toolName === toolName,
      );
      if (siblings.length > 1) {
        out[index] = {
          kind: "approval-batch", key: `approval-batch:${entry.messageId}:${toolName}`,
          messageId: entry.messageId, toolName, items: siblings,
        };
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run — PASS. Run whole shell package + `pnpm typecheck` — PASS.**

- [ ] **Step 5: Commit** — `feat(shell): correlate data-consent parts into ThreadItem; batch sibling approvals (ENG-193 §4.1/§4.5)`

---

### Task 9: Tool-labels — question-form title

**Files:**
- Modify: `packages/flowlet-shell/src/components/tool-labels.ts`
- Test: extend the tool-labels tests (grep for an existing `tool-labels.test.ts`; if none, create one alongside `approval-uinode.test.tsx` using the same import style)

- [ ] **Step 1: Failing test** — append to (or create) `packages/flowlet-shell/src/components/tool-labels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toolAction } from "./tool-labels";

describe("question-form title", () => {
  it("derives a question from the imperative request form by default", () => {
    expect(toolAction("SLACK_API_TEST").question).toBe("Check Slack?");
  });

  it("exact-override tools get a real hand-authored question", () => {
    expect(toolAction("create_automation").question).toBe("Create an automation?");
  });

  it("Gmail send gets its hand-tuned question form", () => {
    expect(toolAction("GMAIL_SEND_EMAIL").question).toBe("Send email?");
  });
});
```

- [ ] **Step 2: Run — FAIL** (`question` doesn't exist on `ToolAction`). `pnpm --filter @flowlet/shell test -- tool-labels.test.ts`

- [ ] **Step 3: Implement** — add `question` to the `ToolAction` interface and derive it everywhere a `ToolAction` object is constructed (every return site in the file), as `${request}?` unless the request already ends in punctuation:

```ts
export interface ToolAction {
  /** "Creating Gmail email draft" — shown while the call runs. */
  active: string;
  /** "Created Gmail email draft" — shown once it settles. */
  done: string;
  /** "Create Gmail email draft" — what the agent is asking permission to do. */
  request: string;
  /** "Create Gmail email draft?" — the approval card's plain yes/no title
   *  (spec Moment 3: "Send Acme a payment reminder?"). Derived from `request`
   *  by default; `EXACT`/Gmail/Slack overrides may hand-author a better one. */
  question: string;
}
```

Add a small helper and use it at the single fallback construction site, and add explicit `question` fields to every literal `ToolAction` object in the file (the `EXACT` table entries, the two hand-tuned `GMAIL_`/`SLACK_` branches, and `fromVerb`'s return):

```ts
/** "Create Gmail email draft" -> "Create Gmail email draft?" — never doubles
 *  a trailing "?" if a hand-authored request already ends with one. */
function toQuestion(request: string): string {
  return request.endsWith("?") ? request : `${request}?`;
}
```

In `fromVerb`, add `question: toQuestion(tail ? \`${base} ${tail}\` : base)` to the returned object. In the `EXACT` table, add a `question` field to each entry (e.g. `create_automation: { ..., question: "Create an automation?" }` — one per existing entry, deriving from each entry's own `request` via `toQuestion` at the call site is simpler than hand-authoring ten; use `question: toQuestion("Create an automation")` style consistently, or — simpler still — since none of the `EXACT` entries need bespoke phrasing beyond the default rule, change the `EXACT` table's type to omit `question` and derive it in `toolAction`'s `EXACT` branch: `if (EXACT[toolName]) return { ...EXACT[toolName], question: toQuestion(EXACT[toolName].request) };`). Apply the same pattern to the two `GMAIL_`/`SLACK_` inline object literals (wrap each returned object with `question: toQuestion(request)` at its return site) and to the final `humanize` fallback (`return { active: h, done: h, request: h, question: toQuestion(h) };`).

- [ ] **Step 4: Run — PASS. Run whole shell package + `pnpm typecheck` — PASS.**

- [ ] **Step 5: Commit** — `feat(shell): question-form tool label for the plain yes/no card title (ENG-193 §3 Moment 3)`

---

### Task 10: `ApprovalCard` v2 — ceremony variant, unverified tag, untruncated critical fields

**Files:**
- Modify: `packages/flowlet-shell/src/components/ApprovalCard.tsx`
- Modify: `packages/flowlet-shell/src/styles.css`
- Test: `packages/flowlet-shell/src/components/approval-uinode.test.tsx` (extend)

- [ ] **Step 1: Failing tests** — append to `approval-uinode.test.tsx`:

```ts
it("uses the question-form title, not the imperative request", () => {
  render(<ApprovalCard toolName="GMAIL_SEND_EMAIL" input={{ to: "acme@example.com" }} onApprove={() => {}} onDecline={() => {}} />);
  expect(screen.getByText("Send email?")).toBeTruthy();
});

it("renders the ceremony variant for a critical tier: amber class, consequence line, named button", () => {
  const { container } = render(
    <ApprovalCard
      toolName="transfer_money"
      input={{ amount: 1200, recipient: "Vendo Inc" }}
      tier="critical"
      onApprove={() => {}}
      onDecline={() => {}}
    />,
  );
  expect(container.querySelector(".fl-approval--ceremony")).toBeTruthy();
  expect(screen.getByText("This can't be undone.")).toBeTruthy();
  expect(screen.getByText("Confirm transfer money")).toBeTruthy();
});

it("does not truncate material fields on a critical card even past 160 chars", () => {
  const long = "x".repeat(300);
  render(
    <ApprovalCard toolName="transfer_money" input={{ note: long }} tier="critical" onApprove={() => {}} onDecline={() => {}} />,
  );
  expect(screen.getByText(long)).toBeTruthy();
});

it("shows an unverified tag when the tool carries no annotation hints", () => {
  render(
    <ApprovalCard toolName="GMAIL_SEND_EMAIL" input={{}} tier="act" unverified onApprove={() => {}} onDecline={() => {}} />,
  );
  expect(screen.getByText(/unverified/i)).toBeTruthy();
});

it("act-tier (default) still truncates and keeps the plain 'Send it'/'No' buttons", () => {
  const long = "x".repeat(300);
  render(<ApprovalCard toolName="GMAIL_SEND_EMAIL" input={{ note: long }} onApprove={() => {}} onDecline={() => {}} />);
  expect(screen.queryByText(long)).toBeNull();
  expect(screen.getByText("Send it")).toBeTruthy();
  expect(screen.getByText("No")).toBeTruthy();
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @flowlet/shell test -- approval-uinode.test.tsx`

- [ ] **Step 3: Rewrite `ApprovalCard.tsx`**

```tsx
import { toolAction } from "./tool-labels";

export interface ApprovalCardProps {
  toolName: string;
  input: unknown;
  /** ENG-193 §4.1 — from the sibling data-consent part. Defaults to "act". */
  tier?: "act" | "critical";
  /** Yousef ruling: unknown-annotation tools land in act but are flagged. */
  unverified?: boolean;
  onApprove: () => void;
  onDecline: () => void;
}

const MAX_ROWS = 8;
const MAX_VALUE_CHARS = 160;

interface FieldRow {
  label: string;
  value: string;
}

function fieldLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `maxChars: null` disables truncation entirely — critical cards never
 *  truncate material fields (spec §3 Moment 6, §4.5 "untruncated"). */
function fieldValue(value: unknown, maxChars: number | null): string {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  if (maxChars === null || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) return true;
  return false;
}

function approvalRows(input: unknown, maxChars: number | null): { rows: FieldRow[]; more: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return isEmpty(input) ? { rows: [], more: 0 } : { rows: [{ label: "Input", value: fieldValue(input, maxChars) }], more: 0 };
  }
  const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => !isEmpty(v));
  const rows = entries.slice(0, MAX_ROWS).map(([k, v]) => ({ label: fieldLabel(k), value: fieldValue(v, maxChars) }));
  return { rows, more: Math.max(0, entries.length - MAX_ROWS) };
}

/**
 * The consent moment (spec §3 Moments 3 & 6): a plain yes/no card for an
 * act-tier action, or the ceremony variant for critical (money/irreversible)
 * actions — amber register, a named confirm button (never generic
 * "Approve"), a fixed consequence line, and NO truncation of material fields.
 */
export function ApprovalCard({ toolName, input, tier = "act", unverified = false, onApprove, onDecline }: ApprovalCardProps) {
  const action = toolAction(toolName);
  const critical = tier === "critical";
  const { rows, more } = approvalRows(input, critical ? null : MAX_VALUE_CHARS);
  const confirmLabel = critical ? `Confirm ${action.request.replace(/^[A-Z]/, (c) => c.toLowerCase())}` : "Send it";
  const declineLabel = critical ? "Cancel" : "No";

  return (
    <div
      className={`fl-approval${critical ? " fl-approval--ceremony" : ""}`}
      role="group"
      aria-label={`Approval request: ${action.question}`}
    >
      <div className="fl-approval-head">
        <span className="fl-approval-ic" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          </svg>
        </span>
        <div className="fl-approval-heading">
          <div className="fl-approval-eyebrow">
            {critical ? "Money — always needs you" : "Needs your approval"}
            {unverified && <span className="fl-approval-unverified">Unverified tool</span>}
          </div>
          <div className="fl-approval-title">{action.question}</div>
        </div>
      </div>
      {rows.length > 0 && (
        <dl className="fl-approval-fields">
          {rows.map((row) => (
            <div key={row.label} className="fl-approval-field">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
          {more > 0 && <div className="fl-approval-more">+{more} more</div>}
        </dl>
      )}
      {critical && <div className="fl-approval-consequence">This can&apos;t be undone.</div>}
      <div className="fl-approval-actions">
        <button
          type="button"
          className={`fl-btn ${critical ? "fl-btn-ceremony" : "fl-btn-primary"}`}
          onClick={onApprove}
        >
          {confirmLabel}
        </button>
        <button type="button" className="fl-btn" onClick={onDecline}>{declineLabel}</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add CSS** — in `styles.css`, add the warn variables right after the existing danger block (around line 27):

```css
  --flowlet-warn: light-dark(#8a5a00, #f0b429);
  --flowlet-warn-bg: light-dark(#fff8e8, color-mix(in srgb, #f0b429 13%, var(--flowlet-surface)));
  --flowlet-warn-border: light-dark(#f0dca0, color-mix(in srgb, #f0b429 32%, var(--flowlet-border)));
```

Add these rules after the existing `.fl-approval-actions`/`.fl-btn-primary` block (around line 257):

```css
.fl-approval--ceremony { border-color: var(--flowlet-warn-border); background: var(--flowlet-warn-bg); }
.fl-approval--ceremony .fl-approval-ic { color: var(--flowlet-warn); background: color-mix(in srgb, var(--flowlet-warn) 16%, transparent); }
.fl-approval--ceremony .fl-approval-eyebrow { color: var(--flowlet-warn); }
.fl-approval-unverified { margin-left: 8px; padding: 1px 6px; border-radius: 999px; font-size: 9.5px;
  font-weight: 700; text-transform: none; letter-spacing: 0; color: var(--flowlet-fg-muted);
  background: color-mix(in srgb, var(--flowlet-fg-muted) 12%, transparent); }
.fl-approval-consequence { margin-top: 10px; font: 600 12px/1.4 var(--flowlet-font); color: var(--flowlet-warn); }
.fl-btn-ceremony { background: var(--flowlet-warn); color: #fff; border-color: transparent;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--flowlet-warn) 40%, transparent); }
.fl-btn-ceremony:hover { opacity: .92; background: var(--flowlet-warn); border-color: transparent; }
```

- [ ] **Step 5: Run — PASS. Run whole shell package + `pnpm typecheck` — PASS.**

- [ ] **Step 6: Commit** — `feat(shell): ApprovalCard v2 — ceremony variant, unverified tag, untruncated critical fields (ENG-193 §3 Moments 3/6)`

---

### Task 11: `ApprovalBatchCard` + `MessageList` wiring

**Files:**
- Create: `packages/flowlet-shell/src/components/ApprovalBatchCard.tsx`
- Modify: `packages/flowlet-shell/src/components/MessageList.tsx`
- Modify: `packages/flowlet-shell/src/index.ts`
- Test: `packages/flowlet-shell/src/components/approval-batch-card.test.tsx`, `packages/flowlet-shell/src/components/message-list.test.tsx` (extend)

- [ ] **Step 1: Failing tests**

`approval-batch-card.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApprovalBatchCard } from "./ApprovalBatchCard";
import type { ThreadItem } from "../use-flowlet-thread";

const items = [
  { kind: "approval", key: "a1", messageId: "m", approvalId: "ap1", toolCallId: "c1", toolName: "GMAIL_SEND_EMAIL", input: { to: "a@x.com" } },
  { kind: "approval", key: "a2", messageId: "m", approvalId: "ap2", toolCallId: "c2", toolName: "GMAIL_SEND_EMAIL", input: { to: "b@x.com" } },
] as Extract<ThreadItem, { kind: "approval" }>[];

describe("ApprovalBatchCard", () => {
  it("shows 'Approve all N' / 'Pick which' / 'No'", () => {
    render(<ApprovalBatchCard toolName="GMAIL_SEND_EMAIL" items={items} onApproveAll={vi.fn()} onApproveSubset={vi.fn()} onDeclineAll={vi.fn()} />);
    expect(screen.getByText("Approve all 2")).toBeTruthy();
    expect(screen.getByText("Pick which…")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
  });

  it("Approve all calls onApproveAll with every approvalId", () => {
    const onApproveAll = vi.fn();
    render(<ApprovalBatchCard toolName="GMAIL_SEND_EMAIL" items={items} onApproveAll={onApproveAll} onApproveSubset={vi.fn()} onDeclineAll={vi.fn()} />);
    fireEvent.click(screen.getByText("Approve all 2"));
    expect(onApproveAll).toHaveBeenCalledWith(["ap1", "ap2"], ["c1", "c2"]);
  });

  it("Pick which expands checkboxes; unchecking one and confirming calls onApproveSubset", () => {
    const onApproveSubset = vi.fn();
    render(<ApprovalBatchCard toolName="GMAIL_SEND_EMAIL" items={items} onApproveAll={vi.fn()} onApproveSubset={onApproveSubset} onDeclineAll={vi.fn()} />);
    fireEvent.click(screen.getByText("Pick which…"));
    fireEvent.click(screen.getByLabelText(/b@x\.com/));
    fireEvent.click(screen.getByText("Approve selected"));
    expect(onApproveSubset).toHaveBeenCalledWith(["ap1"], ["c1"], ["c1", "c2"]);
  });

  it("No calls onDeclineAll with every approvalId", () => {
    const onDeclineAll = vi.fn();
    render(<ApprovalBatchCard toolName="GMAIL_SEND_EMAIL" items={items} onApproveAll={vi.fn()} onApproveSubset={vi.fn()} onDeclineAll={onDeclineAll} />);
    fireEvent.click(screen.getByText("No"));
    expect(onDeclineAll).toHaveBeenCalledWith(["ap1", "ap2"]);
  });
});
```

Extend `message-list.test.tsx`:

```ts
it("renders a batch of sibling approvals as ONE grouped card", () => {
  const onApprove = vi.fn();
  renderList([
    { kind: "approval", key: "a", messageId: "m", approvalId: "ap1", toolCallId: "c1", toolName: "GMAIL_SEND_EMAIL", input: {} },
    { kind: "approval", key: "b", messageId: "m", approvalId: "ap2", toolCallId: "c2", toolName: "GMAIL_SEND_EMAIL", input: {} },
  ], onApprove);
  expect(screen.getByText("Approve all 2")).toBeTruthy();
  expect(screen.queryAllByText("Send it")).toHaveLength(0); // not the single-card path
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @flowlet/shell test -- approval-batch-card.test.tsx message-list.test.tsx`

- [ ] **Step 3: Implement `ApprovalBatchCard.tsx`**

```tsx
import { useState } from "react";
import { toolAction } from "./tool-labels";
import type { ThreadItem } from "../use-flowlet-thread";

type BatchItem = Extract<ThreadItem, { kind: "approval" }>;

export interface ApprovalBatchCardProps {
  toolName: string;
  items: BatchItem[];
  onApproveAll: (approvalIds: string[], toolCallIds: string[]) => void;
  onApproveSubset: (approvalIds: string[], toolCallIds: string[], allToolCallIds: string[]) => void;
  onDeclineAll: (approvalIds: string[]) => void;
}

function summarize(input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["to", "recipient", "recipient_email", "email"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return "";
}

/**
 * Spec §3 Moment 4 — "ten at once → one decision": sibling approval-requested
 * parts of the SAME tool in one assistant message render ONE grouped card.
 * "Approve all N" / "Pick which…" (expands checkboxes) / "No". Each included
 * item is still answered individually on the SDK's native approval channel
 * (the caller loops `addToolApprovalResponse`); this card only decides WHICH
 * approvalIds go in that loop.
 */
export function ApprovalBatchCard({ toolName, items, onApproveAll, onApproveSubset, onDeclineAll }: ApprovalBatchCardProps) {
  const [picking, setPicking] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(items.map((i) => i.approvalId)));
  const action = toolAction(toolName);
  const allApprovalIds = items.map((i) => i.approvalId);
  const allToolCallIds = items.map((i) => i.toolCallId).filter((id): id is string => !!id);

  return (
    <div className="fl-approval" role="group" aria-label={`Approve ${items.length} ${action.done.toLowerCase()}`}>
      <div className="fl-approval-head">
        <div className="fl-approval-heading">
          <div className="fl-approval-eyebrow">Needs your approval</div>
          <div className="fl-approval-title">{action.request} {items.length} times?</div>
        </div>
      </div>
      {picking ? (
        <>
          <ul className="fl-approval-batch-list">
            {items.map((item) => (
              <li key={item.approvalId} className="fl-approval-batch-row">
                <label>
                  <input
                    type="checkbox"
                    aria-label={summarize(item.input) || item.toolCallId || item.approvalId}
                    checked={checked.has(item.approvalId)}
                    onChange={(e) => {
                      const next = new Set(checked);
                      if (e.target.checked) next.add(item.approvalId);
                      else next.delete(item.approvalId);
                      setChecked(next);
                    }}
                  />
                  {summarize(item.input) || action.request}
                </label>
              </li>
            ))}
          </ul>
          <div className="fl-approval-actions">
            <button
              type="button"
              className="fl-btn fl-btn-primary"
              onClick={() => {
                const selected = items.filter((i) => checked.has(i.approvalId));
                onApproveSubset(
                  selected.map((i) => i.approvalId),
                  selected.map((i) => i.toolCallId).filter((id): id is string => !!id),
                  allToolCallIds,
                );
              }}
            >
              Approve selected
            </button>
            <button type="button" className="fl-btn" onClick={() => onDeclineAll(allApprovalIds)}>No</button>
          </div>
        </>
      ) : (
        <div className="fl-approval-actions">
          <button type="button" className="fl-btn fl-btn-primary" onClick={() => onApproveAll(allApprovalIds, allToolCallIds)}>
            Approve all {items.length}
          </button>
          <button type="button" className="fl-btn" onClick={() => setPicking(true)}>Pick which…</button>
          <button type="button" className="fl-btn" onClick={() => onDeclineAll(allApprovalIds)}>No</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire `MessageList.tsx`** — add `onApproveBatch`/`onDeclineBatch` as optional props (fallback to looping the existing single-item callbacks so no existing caller breaks), and handle the new render-item kind:

```tsx
export interface MessageListProps {
  items: ThreadItem[];
  status?: string;
  onApprove: (approvalId: string) => void;
  onDecline?: (approvalId: string) => void;
  /** Batch decisions (ENG-193 §3 Moment 4). Omit to fall back to looping
   *  onApprove/onDecline per item — every existing caller keeps working. */
  onApproveBatch?: (approvalIds: string[], toolCallIds: string[]) => void;
  onApproveSubset?: (approvalIds: string[], toolCallIds: string[], allToolCallIds: string[]) => void;
  onDeclineBatch?: (approvalIds: string[]) => void;
  onRegenerate?: (messageId: string) => void;
  onFeedback?: (messageId: string, feedback: Feedback) => void;
}
```

Add the import (`import { ApprovalBatchCard } from "./ApprovalBatchCard";`) and a new `case` in the render switch, right after the existing `case "approval":` block:

```tsx
            case "approval-batch":
              return (
                <ApprovalBatchCard
                  key={item.key}
                  toolName={item.toolName}
                  items={item.items}
                  onApproveAll={(approvalIds, toolCallIds) =>
                    onApproveBatch ? onApproveBatch(approvalIds, toolCallIds) : approvalIds.forEach(onApprove)
                  }
                  onApproveSubset={(approvalIds, toolCallIds, allToolCallIds) =>
                    onApproveSubset
                      ? onApproveSubset(approvalIds, toolCallIds, allToolCallIds)
                      : approvalIds.forEach(onApprove)
                  }
                  onDeclineAll={(approvalIds) =>
                    onDeclineBatch ? onDeclineBatch(approvalIds) : approvalIds.forEach((id) => onDecline?.(id))
                  }
                />
              );
```

Also thread `tier`/`unverified` from the (now-enriched) `"approval"` `ThreadItem` into the existing single-card branch: change `<ApprovalCard key={item.key} toolName={item.toolName} input={item.input} onApprove={...} onDecline={...} />` to also pass `tier={item.tier}` and `unverified={item.unverified}`.

- [ ] **Step 5: Export `ApprovalBatchCard`** from `packages/flowlet-shell/src/index.ts` (add `export * from "./components/ApprovalBatchCard";` next to the existing `ApprovalCard` export line).

- [ ] **Step 6: Wire `FlowletThread.tsx`** to actually send the consent channel before resuming the SDK's own approval — this needs a `sendConsent` seam. Add it to `ShellContextValue`/`FlowletShellProviderProps` in `context.tsx` (optional, absent → today's exact behavior, no consent POST):

```ts
// context.tsx — ShellContextValue gains:
  /** Posts a ConsentResponse (ENG-193 §4.5). Absent → approve/decline still
   *  work via the SDK's native approval boolean alone, just with no server
   *  grant/audit trail — the graceful no-op default every other seam here has. */
  sendConsent?: (response: import("@flowlet/core").ConsentResponse) => Promise<void>;
```

Add the matching optional prop to `FlowletShellProviderProps`, thread it into the `useMemo` value and its dep array, exactly like every other optional seam in that file.

In `FlowletThread.tsx`, replace `approve`/`decline` and add `approveBatch`/`declineBatch`:

```tsx
  const { integrations, sendConsent } = useShell();
  ...
  const findApproval = (approvalId: string) =>
    chat.items.find((i): i is Extract<typeof chat.items[number], { kind: "approval" }> =>
      i.kind === "approval" && i.approvalId === approvalId,
    );

  const approve = (approvalId: string) => {
    const item = findApproval(approvalId);
    const send =
      item?.toolCallId && sendConsent
        ? sendConsent({ id: item.toolCallId, decision: "yes" })
        : Promise.resolve();
    void send.finally(() => chat.addToolApprovalResponse({ id: approvalId, approved: true }));
  };
  const decline = (approvalId: string) => { void chat.addToolApprovalResponse({ id: approvalId, approved: false }); };

  const approveBatch = (approvalIds: string[], toolCallIds: string[]) => {
    const send = sendConsent
      ? Promise.all(toolCallIds.map((id) => sendConsent({ id, decision: "yes", subset: toolCallIds })))
      : Promise.resolve([]);
    void send.finally(() =>
      approvalIds.forEach((id) => chat.addToolApprovalResponse({ id, approved: true })),
    );
  };
  const approveSubset = (approvalIds: string[], toolCallIds: string[], allToolCallIds: string[]) => {
    const send = sendConsent
      ? Promise.all(toolCallIds.map((id) => sendConsent({ id, decision: "subset", subset: allToolCallIds })))
      : Promise.resolve([]);
    void send.finally(() => {
      approvalIds.forEach((id) => chat.addToolApprovalResponse({ id, approved: true }));
      chat.items
        .filter((i): i is Extract<typeof chat.items[number], { kind: "approval" }> => i.kind === "approval")
        .filter((i) => !approvalIds.includes(i.approvalId) && allToolCallIds.includes(i.toolCallId ?? ""))
        .forEach((i) => chat.addToolApprovalResponse({ id: i.approvalId, approved: false }));
    });
  };
  const declineBatch = (approvalIds: string[]) => {
    approvalIds.forEach((id) => void chat.addToolApprovalResponse({ id, approved: false }));
  };
```

Pass the four new handlers into `<MessageList .../>`: `onApproveBatch={approveBatch} onApproveSubset={approveSubset} onDeclineBatch={declineBatch}` alongside the existing `onApprove={approve} onDecline={decline}`.

- [ ] **Step 7: Run all four test files — PASS. Run whole shell package + `pnpm typecheck` — PASS.**

- [ ] **Step 8: Commit** — `feat(shell): ApprovalBatchCard + consent-channel POST wiring (ENG-193 §3 Moment 4/§4.5)`

---

### Task 12: Receipts — quiet `✓ <done label>` line for settled mutating calls

**Files:**
- Modify: `packages/flowlet-shell/src/components/ActivityStep.tsx`
- Modify: `packages/flowlet-shell/src/styles.css`
- Test: `packages/flowlet-shell/src/components/activity-panel.test.tsx` (extend — this file already renders `ActivityStep` through `ActivityPanel`, per Task-search of `packages/flowlet-shell/src/components/activity-panel.test.tsx`)

- [ ] **Step 1: Failing test** — append (read the existing fixture pattern in `activity-panel.test.tsx` first and mirror its `ToolItem` construction exactly):

```ts
it("shows an expandable receipt row for a settled mutating call, reusing approvalRows fields", () => {
  const { container } = render(
    <ActivityStep
      step={{
        kind: "tool", key: "s1", messageId: "m", toolName: "GMAIL_SEND_EMAIL",
        toolCallId: "c1", state: "output-available", input: { to: "acme@example.com" }, output: "sent",
        tier: "act",
      }}
      showPeek
    />,
  );
  expect(screen.getByText("Sent email")).toBeTruthy();
  expect(container.querySelector(".fl-receipt")).toBeTruthy();
  fireEvent.click(screen.getByText("details"));
  expect(screen.getByText("acme@example.com")).toBeTruthy();
});

it("shows NO receipt affordance for a settled READ call (no tier)", () => {
  const { container } = render(
    <ActivityStep
      step={{ kind: "tool", key: "s2", messageId: "m", toolName: "get_dashboard", state: "output-available", output: {} }}
      showPeek
    />,
  );
  expect(container.querySelector(".fl-receipt")).toBeNull();
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @flowlet/shell test -- activity-panel.test.tsx`

- [ ] **Step 3: Implement** — import `approvalRows`-equivalent logic. Since `ApprovalCard.tsx` doesn't export its row-flattening helper, extract it into a small shared module both files import from (`packages/flowlet-shell/src/components/field-rows.ts`) rather than duplicating it:

Create `field-rows.ts` by MOVING `FieldRow`, `fieldLabel`, `fieldValue`, `isEmpty`, `approvalRows` verbatim out of `ApprovalCard.tsx` into this new file (all `export`ed), and in `ApprovalCard.tsx` replace those five declarations with:

```ts
import { approvalRows } from "./field-rows";
```

In `ActivityStep.tsx`:

```tsx
import { useState } from "react";
import type { ToolItem } from "../use-flowlet-thread";
import { toolAction } from "./tool-labels";
import { peekRows, stepSummary } from "./tool-output";
import { approvalRows } from "./field-rows";

export interface ActivityStepProps {
  step: ToolItem;
  showPeek?: boolean;
}

/**
 * One tool call inside the activity panel. Settled MUTATING calls (act or
 * critical tier — carried on `step.tier`, ENG-193 §4.1/§4.5) additionally get
 * a quiet receipt affordance: "✓ <done label>" plus an expandable details row
 * reusing the same field-flattening ApprovalCard uses, so a receipt reads
 * exactly like the approval card that (maybe) preceded it (spec Moment 2 —
 * "asked → done → receipt", including calls that were silently allowed and
 * never showed a card at all).
 */
export function ActivityStep({ step, showPeek = false }: ActivityStepProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const label = toolAction(step.toolName);
  const done = step.state === "output-available";
  const errored = step.state === "output-error";
  const denied = step.state === "output-denied";
  const rows = showPeek && done ? peekRows(step.output) : [];
  const isReceipt = done && step.tier !== undefined;
  const { rows: detailRows } = isReceipt ? approvalRows(step.input, 160) : { rows: [] };

  return (
    <div className="fl-act-step" data-testid="activity-step" data-state={step.state}>
      <div className="fl-act-row">
        <span className="fl-act-ic" aria-hidden="true">
          {errored ? <span className="fl-act-x">✕</span>
            : denied ? <span className="fl-act-denied">⊘</span>
            : done ? <span className="fl-act-tick">✓</span>
            : <span className="fl-act-spin" />}
        </span>
        <span className="fl-act-lbl">{errored ? `${label.done} failed` : done ? label.done : label.active}</span>
        {errored && step.errorText ? (
          <span className="fl-act-sub fl-act-err">{step.errorText}</span>
        ) : denied ? (
          <span className="fl-act-sub">Declined — didn&apos;t run</span>
        ) : (
          done && <span className="fl-act-sub">{stepSummary(step.output)}</span>
        )}
        {isReceipt && detailRows.length > 0 && (
          <button type="button" className="fl-receipt" onClick={() => setDetailsOpen((v) => !v)}>
            details
          </button>
        )}
      </div>
      {isReceipt && detailsOpen && detailRows.length > 0 && (
        <dl className="fl-approval-fields fl-receipt-fields">
          {detailRows.map((row) => (
            <div key={row.label} className="fl-approval-field">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {rows.length > 0 && (
        <div className="fl-act-peek">
          {rows.map((r, i) => (
            <div key={i} className="fl-act-peek-row">
              <span className="fl-act-peek-k">{r.label}</span>
              <span className="fl-act-peek-v">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

(`approvalRows`'s signature already takes a `maxChars` param per Task 10 — pass `160` here since receipts are a quiet detail disclosure, not the critical-card no-truncation case.)

- [ ] **Step 4: Add CSS** — append near the existing `.fl-act-*` rules:

```css
.fl-receipt { margin-left: 6px; padding: 0; border: none; background: none; cursor: pointer;
  font: 500 10.5px/1 var(--flowlet-font); color: var(--flowlet-fg-muted); text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--flowlet-fg-muted) 45%, transparent); }
.fl-receipt-fields { margin-top: 6px; padding-left: 26px; }
```

- [ ] **Step 5: Run — PASS. Run whole shell package + `pnpm typecheck` — PASS.**

- [ ] **Step 6: Commit** — `feat(shell): receipt line + expandable details for settled mutating calls (ENG-193 §3 Moment 2)`

---

### Task 13: Demo critical-tier fixture + end-to-end integration test

**Files:**
- Modify: `apps/demo-accounting/openapi.json`
- Test: `apps/demo-accounting/src/flowlet/consent-handler.test.ts` (extend)

- [ ] **Step 1: Failing test** — append to `consent-handler.test.ts`:

```ts
it("setDocumentStatus is annotated critical for demo verification (Plan deviations #3)", () => {
  const d = resolveToolDescriptor("setDocumentStatus");
  expect(d).toBeDefined();
  expect(dangerTier(d!)).toBe("critical");
});

it("a grant draft for setDocumentStatus is refused (403) — critical is never grantable", async () => {
  const threadId = await resolveThreadRecordId(CADENCE_SCOPE, "test-thread-critical");
  await demoStore.threads.appendMessages(CADENCE_SCOPE, threadId, [
    { id: "m1", role: "assistant", parts: [
      { type: "tool-setDocumentStatus", toolCallId: "call-crit", state: "approval-requested",
        input: { docId: "d1", action: "reject" }, approval: { id: "ap-crit" } },
    ] } as never,
  ]);
  const res = await handleDemoConsent(req({
    id: "test-thread-critical", toolCallId: "call-crit", toolName: "setDocumentStatus",
    response: { id: "call-crit", decision: "yes",
      grant: { tool: "setDocumentStatus", scope: { kind: "tool" }, duration: "standing" } },
  }));
  expect(res.status).toBe(403);
});
```

(Add the matching imports — `resolveToolDescriptor`, `dangerTier` from `@flowlet/runtime` — at the top of the test file.)

- [ ] **Step 2: Run — FAIL** (the OpenAPI spec has no `x-flowlet-dangerous` on `setDocumentStatus` yet, so `dangerTier` returns `"act"`).

- [ ] **Step 3: Edit `openapi.json`** — find the `setDocumentStatus` operation (the `post` under the document-status path, confirmed at the operation with `"operationId": "setDocumentStatus"`) and add one field to it:

```json
        "operationId": "setDocumentStatus",
        "x-flowlet-dangerous": true,
```

(Insert `"x-flowlet-dangerous": true` as a sibling of `"operationId"` — see "Plan deviations" #3 for why: Cadence has no real money/deletion endpoint, and this is the closest, host-authorized (§9 resolved decision 5) way to exercise the ceremony card end-to-end in the pinned demo.)

- [ ] **Step 4: Run — PASS. Run whole app suite (`pnpm --filter demo-accounting test`) + `pnpm typecheck` + `pnpm build` at repo root — PASS.**

- [ ] **Step 5: Commit** — `test(demo-accounting): critical-tier fixture on setDocumentStatus for ENG-193 verification (demo-only annotation)`

---

### Task 14: Browser verification (Playwright MCP)

**Files:** none (verification only — screenshots land in `docs/superpowers/plans/assets/eng193-item2/`)

- [ ] **Step 1: Start the demo.** `pnpm demo:accounting` (Infisical `dev` env — needs `ANTHROPIC_API_KEY`, `COMPOSIO_API_KEY`; per the runbook, verify Gmail/Calendar are connected for subject `flowlet-demo` first — run `pnpm composio:connect` if the pre-flight check in `docs/superpowers/CADENCE-DEMO-RUNBOOK.md` fails). Open `http://localhost:3000`.

- [ ] **Step 2: Reset the demo world** — `Cmd/Ctrl+Shift+.` (per the runbook) so the run starts from the seeded state and same-day send dedup is cleared.

- [ ] **Step 3: Gated (act-tier) card.** In chat: "Chase Acme about their missing documents" (or the runbook's equivalent chase phrasing) — drives `sendClientMessage` or `GMAIL_SEND_EMAIL`, a plain act-tier approval. Screenshot the card (question-form title, no ceremony styling, "Send it"/"No" buttons) to `docs/superpowers/plans/assets/eng193-item2/01-gated-card.png`. Approve it; screenshot the resulting receipt line + expanded details to `02-receipt.png`.

- [ ] **Step 4: Critical (ceremony) card.** In chat, drive a document status change that maps to `setDocumentStatus` with `action: "reject"` (per Task 13's demo-only annotation) — e.g. "Reject [client]'s uploaded document, wrong file." Screenshot the ceremony card (amber accent, "This can't be undone.", named confirm button, untruncated fields) to `03-ceremony-card.png`. Caption in the PR description that this uses the demo-only `x-flowlet-dangerous` fixture from Task 13/"Plan deviations" #3, not a shipped Cadence classification.

- [ ] **Step 5: Batch card.** Ask something that fans out to multiple sibling sends in one turn — the runbook's "chase everyone overdue"-shaped request (multiple clients missing documents) — so 2+ `GMAIL_SEND_EMAIL` (or `sendClientMessage`) approval-requested parts land in one assistant message. Screenshot the collapsed "Approve all N / Pick which… / No" state to `04-batch-card.png`, then click "Pick which…" and screenshot the expanded checkbox list to `05-batch-picker.png`.

- [ ] **Step 6: Unverified tag.** If a Composio tool (e.g. `GOOGLECALENDAR_CREATE_EVENT`) surfaces during the session, screenshot its card showing the "Unverified tool" tag to `06-unverified-tag.png`. (Every Composio tool in this demo is unverified per Task 6's `tool-registry.ts` — any Calendar create/Gmail send card qualifies.)

- [ ] **Step 7 (optional, per deviation #5): production-mount smoke check.** If Yousef wants the `@flowlet/next` path seen live: `pnpm demo` (demo-bank, the `createFlowletHandler` mount), drive one gated `createOrder` approval, and confirm the same card renders and a `POST /api/flowlet/consent` succeeds (network tab). One screenshot to `07-demo-bank-handler.png`. The route-level behavior is already covered by Task 5's unit tests — this step is presentation, not verification.

- [ ] **Step 8: Save all screenshots** under `docs/superpowers/plans/assets/eng193-item2/` and reference them in the PR description with the numbered captions above.

- [ ] **Step 9: Stop the demo, `git status` to confirm only the planned files changed**, and hand back to Yousef for the merge-gate review (CLAUDE.md standing rule — nothing visual ships without him).

---

## Self-review checklist (run after all tasks)

- **§4.1 tiers on the wire** ✔ Task 1 (`ConsentTierPart`), Task 2 (write site).
- **§4.5 consent channel (ConsentRequest/ConsentResponse)** ✔ Task 1 (schemas, v1-narrowed to `kind: "approval"`, extension point documented) · Task 4 (`handleConsent`) · Task 5 (`@flowlet/next` production route — demo-bank inherits it) · Task 7 (accounting hand-rolled route) · Task 11 (client POST wiring).
- **§4.5 "server-validated against the pending request"** ✔ Task 4 steps (a)–(e) exactly as ruled: loads thread messages (Store seam — Task 3 engine hook, persistence in Tasks 5/6), finds the approval-requested part by toolCallId, confirms tool name, resolves the live descriptor (Task 5's handler resolver / Task 6's `tool-registry.ts`), calls `createGrantManager.create` (self-derived criticality, 403 on critical), appends a `consent` audit event.
- **§4.3 grantPolicy wired into production for the first time** ✔ Task 5 (`composeProductionPolicy` in `createFlowletHandler` — wraps `options.policy ?? defaultFlowletPolicy`, so demo-bank's `demoPolicy` is covered) · Task 7 (accounting demo, composed onto `namePolicy`; `contextKey: threadId` on both).
- **§3 Moment 2 (asked → done → receipt)** ✔ Task 12, via the SAME `data-consent` write used for cards (Task 2) — covers silently-allowed mutating calls, not just approved ones.
- **§3 Moment 3 (plain yes/no, question-form title)** ✔ Task 9 (`question` label) · Task 10 (card uses it).
- **§3 Moment 4 (batch: Approve all N / Pick which / No)** ✔ Task 8 (grouping) · Task 11 (`ApprovalBatchCard`).
- **§3 Moment 6 (ceremony: amber, consequence line, named button, no truncation, unsuppressible)** ✔ Task 10. Unsuppressibility itself is an item-1 invariant (`grantPolicy` refuses critical by type) — item 2 only had to make sure the CARD reflects it; the Task 5/7 policy compositions don't touch that invariant (re-asserted by Task 5's `policy-stack.test.ts` INVARIANT case).
- **§6.5 batch subset still answers each SDK approval id individually** ✔ Task 11 (`approveBatch`/`approveSubset` loop `addToolApprovalResponse` per included id; declined-in-subset items are explicitly answered `false`, never left dangling).
- **Browser verification** ✔ Task 14, against the real `pnpm demo:accounting` app per the CLAUDE.md UI-verification rule (optional demo-bank smoke check for the `@flowlet/next` mount, deviation #5).
- **NOT in this plan** (later items, by design): the judge and its `PolicyContext` extension beyond `threadId` (item 3), parking/automation consent (item 4), fades/Trust screen/diary (item 5), NL steering compilation (item 6), migrating `demo-accounting`/`gmail` to `@flowlet/next` (deviation #1 — separate cleanup).
