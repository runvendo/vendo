# ENG-193 Item 5 — Fade proposals + Trust screen + weekly diary: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **UI gate: per Yousef's standing waiver for this build run (2026-07-04, "build it all, review at the end") — proceed through the shell/UI tasks (11–14) without pausing; the PR stays unmerged and every visual surface (FadeProposalCard, TrustScreen, the shield button) gets screenshots in the PR for his single end review.**

**Goal:** Ship-order item 5 from `docs/superpowers/specs/2026-07-02-eng193-permissions-design.md` §10 (read §3 Moments 5/10/12, §4.4, §4.3, §9): the agent-proposed fade ("that's the third time you've okayed this — want me to handle these without checking?"), the Trust screen (behind a quiet shield icon), and the weekly diary line. Builds on the landed base: `packages/flowlet-runtime/src/consent.ts` (`handleConsent`), `grant-manager.ts`, `grant-store.ts`, `policy/grant-match.ts`, `policy/tier.ts`, the automations grant/version machinery, `@flowlet/next`'s catch-all handler, and the accounting demo's parallel hand-rolled routes + the shell's `WaitingList`/`useParkedActions`/`ApprovalCard`/`tool-labels` seam pattern. Items 6 (steering) and v2 (envelopes/undo) are explicitly out of scope.

**Architecture:**
- **Fade tracking is server-side, inside `handleConsent`** — it already resolves `toolName` and the approval part's `input`. A new injectable `FadeTracker` (`packages/flowlet-runtime/src/fade-tracker.ts`, the same in-memory-keyed-by-principal shape as `BreakerState`) records every yes/no as a *shape* (tool + a deterministically derived constraint, `policy/fade-shapes.ts`) in a rolling per-principal window, and offers a proposal once a shape clears the eligibility bar. `handleConsent`'s successful response gains an optional `fadeEligible: {shape, proposalId}`.
- **Acceptance/decline ride a NEW, proposalId-keyed resolution** (`packages/flowlet-runtime/src/fade-proposal.ts`, `handleFadeProposal`) — not `ConsentResponse` (same reasoning `ParkedActionResolution` already established: no toolCallId/thread part exists for a fade proposal). The server **re-derives** eligibility from the tracker's own memory before minting anything; a client can never supply or forge a shape.
- **`@flowlet/core`** gains `fadeShapeSchema`/`FadeShape`, `fadeProposalResolutionSchema`/`FadeProposalResolution`, and a `"fade-proposal"` variant on `ConsentRequest` (the documented extension point item 2 reserved) — additive, mirroring `ParkedActionResolution`'s precedent exactly.
- **`@flowlet/next` and the accounting demo** both grow: a `fade-proposal` route, and three new read surfaces the Trust screen needs — `grants` (list, principal-scoped, **federates** the standing `GrantStore` with automation versions' grants + names per spec §4.3's own federation language), `grants/revoke`, `audit` (query, last-N/since), and `critical-tools` (static-derivable from the registered toolset, no store).
- **`@flowlet/shell`** gets `FadeProposalCard` (wired into `FlowletThread`/`MessageList` right after the turn it followed), a `useTrustData` hook (mirrors `useParkedActions`' seam pattern exactly), and `TrustScreen` (the five sections + the diary line, derived client-side from the `audit` endpoint's last-7-days rows).
- **The accounting demo** mounts a quiet shield button in the page chrome (`assistant/page.tsx`, beside the tab strip where `WaitingList` already sits) that opens `TrustScreen`.
- **A necessary prerequisite the diary exposed:** automation-fired tool calls today leave **no** audit trail at all (`AutomationRunner` never calls `wrapTool`'s policy/audit chain for granted in-run steps), and the already-declared `automation_firing` audit kind has never been appended anywhere. Task 6 wires it — one `automation_firing` event per finalized run, and one `tool_execution` event per successfully-resolved parked action — the minimum needed for "Z ran in automations" and "Money moves: M" to mean anything.

**Tech Stack:** TypeScript, zod (core schemas), vitest (`pnpm --filter <pkg> test`), `@testing-library/react`, existing FNV-1a/canonicalJson hashing (`packages/flowlet-runtime/src/hashing.ts`), Playwright MCP for the browser-verification task.

**Conventions:** run tests with `pnpm --filter @flowlet/core test -- <file>` / `pnpm --filter @flowlet/runtime test -- <file>` / `pnpm --filter @flowlet/shell test -- <file>`; typecheck with `pnpm typecheck`. Commit after each task. Follow existing file style: module docstring explaining the WHY, named exports, no default exports. Targeted `Edit`s over rewrites.

---

## Plan deviations from scope rulings

1. **Ruling #2's `sendConsent kind "fade-proposal" {proposalId, accept:true}` is NOT `ConsentResponse`.** `ConsentResponse` is keyed by an ai SDK `toolCallId` against a pending thread part; a fade proposal has neither. This is the exact shape of problem `ParkedActionResolution` already solved (see its own docstring: "Deliberately NOT `ConsentResponse`"). **Resolution:** a sibling `FadeProposalResolution` (`{proposalId, accept}`) + its own `handleFadeProposal`/route/client-seam function, structurally identical in spirit to the parked-action precedent. `ConsentRequest` still gains the `"fade-proposal"` kind per the ruling's literal text (Task 1) — but, like `"parked-action"` before it, that union member stays a documented contract-completeness addition never actually constructed by runtime code (verified: nothing in the tree parses `consentRequestSchema` today outside its own test); the real wire traffic is `fadeEligible` (on `HandleConsentResult`) and `FadeProposalResolution`.
2. **Ruling #3's endpoint list ("grants list/revoke, audit query, critical-tools") doesn't separately name an "automations" endpoint**, yet the Trust screen's "Automations" section needs automation-version grants joined to automation names. Spec §4.3 already says this explicitly: *"The Trust screen federates both stores, joining `AutomationVersion.spec` for human labels."* **Resolution:** the single `grants` endpoint federates `GrantStore` rows (`source: "chat"|"fade"|"compiled-rule"`) with synthetic automation-sourced rows (`source: "automation"`, `automationName`, read-only, no `id`) — no extra endpoint, matching the ruling's own enumerated four.
3. **Ruling #5's "critical-tools endpoint ... no store" doesn't say who formats friendly labels.** `@flowlet/next` and the accounting demo's server routes have no dependency on `@flowlet/shell` (and shouldn't gain one — `tool-labels.ts` is UI copy). **Resolution:** the endpoint returns raw `{name: string}[]`; the client (`TrustScreen`) applies `toolAction(name).request` itself, exactly like `WaitingList`/`ApprovalCard` already do for every other tool-name-to-copy need.
4. **"FadeProposalCard inline right after that approval" (ruling #2) is imprecise against the actual thread model:** once a decision resolves, the ai SDK part transitions out of `"approval-requested"` and `groupThreadItems` folds it into that turn's `ActivityPanel` — the approval card itself is gone by the time a fade could be offered. **Resolution:** the card renders immediately after the `ActivityPanel` for the SAME `messageId` the approval belonged to (Task 11) — the closest faithful "right after that approval, in the same turn" placement the grouped-item architecture supports.
5. **The diary's "Z ran in automations" and "Money moves: M" required a genuine audit-wiring gap to be closed** (see Architecture above) — not named in any ruling, but load-bearing for item 5's own stated deliverable. Task 6 closes it at firing-granularity (one `automation_firing` per run, not per tool call inside the run) — this matches the spec's own mock copy ("2 automations ran 9 times" is a firing count) and avoids threading `runContext` through every interpreter step, which item 4 deliberately didn't do either.
6. **No `runContext` population.** `PolicyContext.runContext` (declared in item 1, reserved for item 4) is still nowhere populated after item 4 — item 4's parking logic didn't need it, and this item's diary doesn't either (firing-granularity per #5 above sidesteps it entirely). Left untouched; flagged here so a future item doesn't assume it's live.

---

### Task 1: Fade wire contract in `@flowlet/core`

**Files:**
- Create: `packages/flowlet-core/src/fade.ts`
- Modify: `packages/flowlet-core/src/consent.ts` (add `"fade-proposal"` kind to `consentRequestSchema`)
- Modify: `packages/flowlet-core/src/index.ts` (export `./fade`)
- Test: `packages/flowlet-core/src/fade.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { fadeShapeSchema, fadeProposalResolutionSchema } from "./fade";
import { consentRequestSchema } from "./consent";

describe("fade wire contract", () => {
  it("accepts a constrained fade shape", () => {
    const shape = fadeShapeSchema.parse({ kind: "constrained", path: "to", op: "matches", value: "*@acme.co" });
    expect(shape.kind).toBe("constrained");
  });
  it("accepts the tool-wide fallback shape", () => {
    expect(fadeShapeSchema.parse({ kind: "tool" }).kind).toBe("tool");
  });
  it("rejects op values a fade shape never uses (lte/gte)", () => {
    expect(() => fadeShapeSchema.parse({ kind: "constrained", path: "amount", op: "lte", value: 5 })).toThrow();
  });
  it("parses a fade-proposal resolution", () => {
    const r = fadeProposalResolutionSchema.parse({ proposalId: "p-1", accept: true });
    expect(r.accept).toBe(true);
  });
  it("rejects extra fields (strict)", () => {
    expect(() => fadeProposalResolutionSchema.parse({ proposalId: "p", accept: true, extra: 1 })).toThrow();
  });
  it("ConsentRequest admits kind 'fade-proposal'", () => {
    const req = consentRequestSchema.parse({
      id: "p-1", kind: "fade-proposal", tier: "act",
      toolName: "GMAIL_SEND_EMAIL", inputPreview: "reminder emails to your clients",
    });
    expect(req.kind).toBe("fade-proposal");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `pnpm --filter @flowlet/core test -- fade.test.ts`

- [ ] **Step 3: Implement `fade.ts`**

```ts
import { z } from "zod";

/**
 * A fade proposal's derived scope shape (ENG-193 spec §4.4). Computed
 * server-side by `deriveFadeShape` (@flowlet/runtime's `policy/fade-shapes.ts`)
 * and carried in `fadeEligible` (the runtime `handleConsent`'s result) so the
 * client can render a bit of context without re-deriving anything — the
 * client never derives or supplies a shape, only ever echoes a `proposalId`.
 * Intentionally the SAME leaf as `GrantConstraint` minus the array wrapper: a
 * fade always narrows on ONE field or falls back to the whole tool.
 */
export const fadeShapeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool") }).strict(),
  z
    .object({
      kind: z.literal("constrained"),
      path: z.string().min(1),
      op: z.enum(["eq", "matches"]),
      value: z.union([z.string(), z.number(), z.boolean()]),
    })
    .strict(),
]);
export type FadeShape = z.infer<typeof fadeShapeSchema>;

/**
 * The wire object POSTed to accept/decline a fade proposal (ENG-193 §4.4/§4.5).
 * Deliberately NOT `ConsentResponse` — a fade proposal is keyed by its own
 * `proposalId`, not an ai SDK toolCallId against a pending thread part (same
 * reasoning as `ParkedActionResolution`, see consent.ts).
 */
export const fadeProposalResolutionSchema = z
  .object({
    proposalId: z.string(),
    accept: z.boolean(),
  })
  .strict();
export type FadeProposalResolution = z.infer<typeof fadeProposalResolutionSchema>;
```

- [ ] **Step 4: Add the `"fade-proposal"` kind to `consent.ts`'s union**

In `packages/flowlet-core/src/consent.ts`, add (below `parkedActionConsentRequestSchema`):

```ts
/**
 * ENG-193 §4.4 — the fade proposal card's own kind: "that's the third time
 * you've okayed this — want me to handle these without checking?" Like
 * `"parked-action"` before it, this is the documented extension point item
 * 2's docstring reserved — a contract-completeness addition; the actual
 * accept/decline wire object is `FadeProposalResolution` (see fade.ts), not
 * a `ConsentResponse` against this request.
 */
const fadeProposalConsentRequestSchema = z
  .object({
    /** The proposal's own id (FadeTracker-assigned, deterministic) — reused
     *  as this request's id; there is no separate toolCallId. */
    id: z.string(),
    kind: z.literal("fade-proposal"),
    tier: z.literal("act"),
    toolName: z.string(),
    /** Plain-language description of the narrowed shape, e.g. "reminder
     *  emails to your clients" — never "all email" (spec §3 Moment 5). */
    inputPreview: z.string(),
  })
  .strict();
```

Update the union: `z.discriminatedUnion("kind", [approvalConsentRequestSchema, parkedActionConsentRequestSchema, fadeProposalConsentRequestSchema])`. Update the module docstring's line `"fade-proposal" (§4.4) joins it in a later item.` to `"fade-proposal" (§4.4) — see fade.ts for its real accept/decline wire object.`

- [ ] **Step 5: Export from `packages/flowlet-core/src/index.ts`** — add `export * from "./fade";` beside the existing `export * from "./consent";`.

- [ ] **Step 6: Run test — PASS. `pnpm --filter @flowlet/core test` + `pnpm typecheck` — PASS. Commit** — `feat(core): fade shape + fade-proposal resolution wire contract (ENG-193 §4.4)`

---

### Task 2: Fade shape derivation heuristic

**Files:**
- Create: `packages/flowlet-runtime/src/policy/fade-shapes.ts`
- Test: `packages/flowlet-runtime/src/policy/fade-shapes.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { deriveFadeShape, shapeKey, grantScopeFromShape, computeProposalId } from "./fade-shapes";

describe("deriveFadeShape", () => {
  it("first email-shaped string field -> matches on its domain", () => {
    expect(deriveFadeShape({ to: "jim@acme.co", subject: "hi" }))
      .toEqual({ kind: "constrained", path: "to", op: "matches", value: "*@acme.co" });
  });
  it("prefers the FIRST email field over a later one", () => {
    expect(deriveFadeShape({ cc: "b@x.co", to: "a@acme.co" }).path).toBe("cc");
  });
  it("falls back to a type/kind/status/category string field", () => {
    expect(deriveFadeShape({ amount: 100, type: "invoice" }))
      .toEqual({ kind: "constrained", path: "type", op: "eq", value: "invoice" });
  });
  it("falls back to tool-wide when nothing matches", () => {
    expect(deriveFadeShape({ amount: 100 })).toEqual({ kind: "tool" });
  });
  it("falls back to tool-wide for non-object input", () => {
    expect(deriveFadeShape("raw string")).toEqual({ kind: "tool" });
    expect(deriveFadeShape(null)).toEqual({ kind: "tool" });
    expect(deriveFadeShape(["a@b.co"])).toEqual({ kind: "tool" });
  });
});

describe("shapeKey", () => {
  it("is stable and shape-distinguishing", () => {
    const a = deriveFadeShape({ to: "a@acme.co" });
    const b = deriveFadeShape({ to: "b@acme.co" });
    expect(shapeKey(a)).toBe(shapeKey(b)); // same domain -> same shape
    expect(shapeKey({ kind: "tool" })).toBe("tool");
  });
});

describe("grantScopeFromShape", () => {
  it("tool shape -> tool scope", () => {
    expect(grantScopeFromShape({ kind: "tool" })).toEqual({ kind: "tool" });
  });
  it("constrained shape -> a ONE-constraint constrained scope (never wider)", () => {
    const shape = deriveFadeShape({ to: "a@acme.co" });
    expect(grantScopeFromShape(shape)).toEqual({
      kind: "constrained", constraints: [{ path: "to", op: "matches", value: "*@acme.co" }],
    });
  });
});

describe("computeProposalId", () => {
  it("is deterministic for the same principal+tool+shape", () => {
    const p = { tenantId: "t", subject: "u" };
    const shape = deriveFadeShape({ to: "a@acme.co" });
    expect(computeProposalId(p, "send_email", shape)).toBe(computeProposalId(p, "send_email", shape));
  });
  it("differs across tools/principals/shapes", () => {
    const p = { tenantId: "t", subject: "u" };
    const shape = deriveFadeShape({ to: "a@acme.co" });
    const other = deriveFadeShape({ to: "a@other.co" });
    expect(computeProposalId(p, "send_email", shape)).not.toBe(computeProposalId(p, "other_tool", shape));
    expect(computeProposalId(p, "send_email", shape)).not.toBe(computeProposalId({ ...p, subject: "u2" }, "send_email", shape));
    expect(computeProposalId(p, "send_email", shape)).not.toBe(computeProposalId(p, "send_email", other));
  });
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @flowlet/runtime test -- fade-shapes.test.ts`

- [ ] **Step 3: Implement**

```ts
/**
 * Fade shape derivation (ENG-193 spec §4.4) — deterministic, no model in the
 * loop. Every act-tier yes/no decision is filed under exactly one shape, so
 * "is this the 3rd yes of the same kind" is a pure structural question.
 *
 * Heuristic (orchestrator scope ruling, 2026-07-04):
 *  1. First input field whose STRING value looks like an email -> a
 *     `matches` constraint on that field, narrowed to the email's DOMAIN
 *     (never the literal address — "reminder emails to your clients", not
 *     one person).
 *  2. Else the first field named type/kind/status/category with a string
 *     value -> an `eq` constraint on that field.
 *  3. Else tool-wide ({kind:"tool"}) — the fallback every input can reach.
 *
 * `computeProposalId` is a hash, not an opaque random id, ON PURPOSE: the
 * server never needs to remember it to know what it means — `FadeTracker`
 * still keeps a small offered-proposal map (fade-tracker.ts) so it never has
 * to re-derive a shape from a client-supplied value, but the hash itself
 * guarantees the SAME shape always gets the SAME id (idempotent re-offers).
 */
import type { FadeShape, GrantScope } from "@flowlet/core";
import { canonicalJson, fnv1a64 } from "../hashing";

const EMAIL_RE = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;
const TYPE_FIELD_NAMES = ["type", "kind", "status", "category"];

export function deriveFadeShape(input: unknown): FadeShape {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { kind: "tool" };
  }
  const obj = input as Record<string, unknown>;
  for (const [path, value] of Object.entries(obj)) {
    if (typeof value !== "string") continue;
    const m = EMAIL_RE.exec(value);
    if (m) return { kind: "constrained", path, op: "matches", value: `*@${m[1]}` };
  }
  for (const name of TYPE_FIELD_NAMES) {
    const value = obj[name];
    if (typeof value === "string") return { kind: "constrained", path: name, op: "eq", value };
  }
  return { kind: "tool" };
}

/** Stable string key for window/suppression bucketing — two shapes with the
 *  same key are the "same kind" of decision (ENG-193 §4.4). */
export function shapeKey(shape: FadeShape): string {
  return shape.kind === "tool" ? "tool" : `${shape.path}:${shape.op}:${String(shape.value)}`;
}

/** A fade shape narrows to EXACTLY the grant scope it describes — never
 *  wider (ENG-193 §7 invariant: accept mints a grant matching ONLY the
 *  derived shape, tool-wide only when the shape itself was tool-wide). */
export function grantScopeFromShape(shape: FadeShape): GrantScope {
  return shape.kind === "tool"
    ? { kind: "tool" }
    : { kind: "constrained", constraints: [{ path: shape.path, op: shape.op, value: shape.value }] };
}

/** Deterministic proposal id: a hash of principal+tool+shape. */
export function computeProposalId(
  principal: { tenantId: string; subject: string },
  tool: string,
  shape: FadeShape,
): string {
  return fnv1a64(canonicalJson({ tenantId: principal.tenantId, subject: principal.subject, tool, shape }));
}
```

- [ ] **Step 4: Run — PASS. Export `./fade-shapes` from `packages/flowlet-runtime/src/policy/index.ts`. Commit** — `feat(runtime): deterministic fade shape derivation (ENG-193 §4.4)`

---

### Task 3: FadeTracker

**Files:**
- Create: `packages/flowlet-runtime/src/fade-tracker.ts`
- Test: `packages/flowlet-runtime/src/fade-tracker.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { createFadeTracker } from "./fade-tracker";

const p = { tenantId: "t", subject: "u" };
const other = { tenantId: "t", subject: "u2" };

describe("FadeTracker", () => {
  it("proposes after 3 yes of the same shape, not before", () => {
    const t = createFadeTracker();
    t.record(p, "send_email", { to: "a@acme.co" }, "yes");
    t.record(p, "send_email", { to: "b@acme.co" }, "yes");
    expect(t.propose(p, "send_email", { to: "c@acme.co" })).toBeNull();
    t.record(p, "send_email", { to: "c@acme.co" }, "yes");
    const eligible = t.propose(p, "send_email", { to: "d@acme.co" });
    expect(eligible?.shape).toEqual({ kind: "constrained", path: "to", op: "matches", value: "*@acme.co" });
    expect(eligible?.proposalId).toBeTruthy();
  });

  it("a single no of the same shape blocks eligibility even with 3+ yes", () => {
    const t = createFadeTracker();
    t.record(p, "send_email", { to: "a@acme.co" }, "yes");
    t.record(p, "send_email", { to: "b@acme.co" }, "yes");
    t.record(p, "send_email", { to: "c@acme.co" }, "no");
    t.record(p, "send_email", { to: "d@acme.co" }, "yes");
    expect(t.propose(p, "send_email", { to: "e@acme.co" })).toBeNull();
  });

  it("different shapes never share a count", () => {
    const t = createFadeTracker();
    t.record(p, "send_email", { to: "a@acme.co" }, "yes");
    t.record(p, "send_email", { to: "b@other.co" }, "yes");
    t.record(p, "send_email", { to: "c@third.co" }, "yes");
    expect(t.propose(p, "send_email", { to: "d@acme.co" })).toBeNull();
  });

  it("principals never share state", () => {
    const t = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) t.record(p, "send_email", { to }, "yes");
    expect(t.propose(other, "send_email", { to: "d@acme.co" })).toBeNull();
  });

  it("the rolling window (default 20) ages out old decisions", () => {
    const t = createFadeTracker({ windowSize: 5, threshold: 3 });
    t.record(p, "send_email", { to: "a@acme.co" }, "yes");
    t.record(p, "send_email", { to: "b@acme.co" }, "yes");
    t.record(p, "send_email", { to: "c@acme.co" }, "yes");
    // 4 unrelated decisions push the 3 yeses out of a window of 5.
    for (let i = 0; i < 4; i++) t.record(p, "other_tool", { to: `x${i}@z.co` }, "yes");
    expect(t.propose(p, "send_email", { to: "d@acme.co" })).toBeNull();
  });

  it("resolveEligible re-verifies live and rejects a stale/forged proposalId", () => {
    const t = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) t.record(p, "send_email", { to }, "yes");
    const offer = t.propose(p, "send_email", { to: "d@acme.co" })!;
    expect(t.resolveEligible(p, offer.proposalId)).toEqual({ tool: "send_email", shape: offer.shape });
    expect(t.resolveEligible(p, "not-a-real-id")).toBeUndefined();
    expect(t.resolveEligible(other, offer.proposalId)).toBeUndefined(); // wrong principal
  });

  it("a 'no' recorded AFTER an offer sours resolveEligible (never trust the client)", () => {
    const t = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) t.record(p, "send_email", { to }, "yes");
    const offer = t.propose(p, "send_email", { to: "d@acme.co" })!;
    t.record(p, "send_email", { to: "e@acme.co" }, "no");
    expect(t.resolveEligible(p, offer.proposalId)).toBeUndefined();
  });

  it("decline suppresses re-proposal of the exact shape", () => {
    const t = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) t.record(p, "send_email", { to }, "yes");
    const offer = t.propose(p, "send_email", { to: "d@acme.co" })!;
    expect(t.decline(p, offer.proposalId)).toEqual({ tool: "send_email", shape: offer.shape });
    t.record(p, "send_email", { to: "f@acme.co" }, "yes"); // more yeses...
    expect(t.propose(p, "send_email", { to: "g@acme.co" })).toBeNull(); // ...still suppressed
  });

  it("decline is idempotent-safe against an unknown id", () => {
    const t = createFadeTracker();
    expect(t.decline(p, "unknown")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @flowlet/runtime test -- fade-tracker.test.ts`

- [ ] **Step 3: Implement**

```ts
/**
 * FadeTracker (ENG-193 spec §4.4) — server-side, per-principal memory of
 * human yes/no decisions on act-tier calls, driving the fade proposal.
 * Injectable in-memory state (the `BreakerState`/`GrantStore` pattern) — a
 * cloud deployment swaps this for persistence behind the same shape.
 *
 * ELIGIBILITY: within the principal's last `windowSize` (default 20)
 * decisions of ANY tool/shape, >= `threshold` (default 3) "yes" of the SAME
 * shape and ZERO "no" of that shape. A declined proposal suppresses
 * re-proposing that exact shape (stored, not time-limited).
 *
 * TRUST BOUNDARY: `resolveEligible` looks up what THIS tracker itself
 * offered (never a client-supplied shape) and RE-CHECKS eligibility live —
 * a "no" or a decline landing between the offer and an accept must sour the
 * accept, never silently mint a grant anyway.
 */
import type { FadeShape } from "@flowlet/core";
import { deriveFadeShape, shapeKey, computeProposalId } from "./policy/fade-shapes";

export interface FadeTrackerOptions {
  /** "Yes" count required (same shape, zero "no") before offering. Default 3. */
  threshold?: number;
  /** Rolling per-principal decision window. Default 20. */
  windowSize?: number;
}

export interface FadeEligibility {
  shape: FadeShape;
  proposalId: string;
}

interface Decision {
  tool: string;
  shapeKey: string;
  decision: "yes" | "no";
}

interface PrincipalState {
  /** Rolling window, oldest first, capped at windowSize. */
  decisions: Decision[];
  /** `${tool}::${shapeKey}` -> declined forever (until explicitly cleared). */
  suppressed: Set<string>;
}

interface OfferedProposal {
  principalKey: string;
  tool: string;
  shape: FadeShape;
}

export interface FadeTracker {
  record(principal: { tenantId: string; subject: string }, tool: string, input: unknown, decision: "yes" | "no"): void;
  propose(principal: { tenantId: string; subject: string }, tool: string, input: unknown): FadeEligibility | null;
  resolveEligible(
    principal: { tenantId: string; subject: string },
    proposalId: string,
  ): { tool: string; shape: FadeShape } | undefined;
  decline(
    principal: { tenantId: string; subject: string },
    proposalId: string,
  ): { tool: string; shape: FadeShape } | undefined;
}

function principalKey(p: { tenantId: string; subject: string }): string {
  return `${p.tenantId}::${p.subject}`;
}
function suppressionKey(tool: string, key: string): string {
  return `${tool}::${key}`;
}

export function createFadeTracker(opts: FadeTrackerOptions = {}): FadeTracker {
  const threshold = opts.threshold ?? 3;
  const windowSize = opts.windowSize ?? 20;
  const principals = new Map<string, PrincipalState>();
  const offered = new Map<string, OfferedProposal>();

  function stateFor(p: { tenantId: string; subject: string }): PrincipalState {
    const key = principalKey(p);
    let state = principals.get(key);
    if (!state) {
      state = { decisions: [], suppressed: new Set() };
      principals.set(key, state);
    }
    return state;
  }

  function isEligible(state: PrincipalState, tool: string, key: string): boolean {
    if (state.suppressed.has(suppressionKey(tool, key))) return false;
    const inWindow = state.decisions.filter((d) => d.tool === tool && d.shapeKey === key);
    const yes = inWindow.filter((d) => d.decision === "yes").length;
    const no = inWindow.filter((d) => d.decision === "no").length;
    return yes >= threshold && no === 0;
  }

  return {
    record(principal, tool, input, decision) {
      const state = stateFor(principal);
      const shape = deriveFadeShape(input);
      state.decisions.push({ tool, shapeKey: shapeKey(shape), decision });
      if (state.decisions.length > windowSize) state.decisions.shift();
    },

    propose(principal, tool, input) {
      const state = stateFor(principal);
      const shape = deriveFadeShape(input);
      const key = shapeKey(shape);
      if (!isEligible(state, tool, key)) return null;
      const id = computeProposalId(principal, tool, shape);
      offered.set(id, { principalKey: principalKey(principal), tool, shape });
      return { shape, proposalId: id };
    },

    resolveEligible(principal, proposalId) {
      const offer = offered.get(proposalId);
      if (!offer || offer.principalKey !== principalKey(principal)) return undefined;
      const state = stateFor(principal);
      if (!isEligible(state, offer.tool, shapeKey(offer.shape))) return undefined;
      return { tool: offer.tool, shape: offer.shape };
    },

    decline(principal, proposalId) {
      const offer = offered.get(proposalId);
      if (!offer || offer.principalKey !== principalKey(principal)) return undefined;
      const state = stateFor(principal);
      state.suppressed.add(suppressionKey(offer.tool, shapeKey(offer.shape)));
      return { tool: offer.tool, shape: offer.shape };
    },
  };
}
```

- [ ] **Step 4: Run — PASS. Export `createFadeTracker`/`FadeTracker`/`FadeEligibility` from `packages/flowlet-runtime/src/index.ts` (beside the grant-store export). `pnpm typecheck` PASS. Commit** — `feat(runtime): FadeTracker — per-principal fade eligibility with server-side re-verification (ENG-193 §4.4)`

---

### Task 4: Wire fade eligibility into `handleConsent`

**Files:**
- Modify: `packages/flowlet-runtime/src/consent.ts`
- Modify: `packages/flowlet-runtime/src/consent.test.ts` (new cases)

- [ ] **Step 1: Add failing tests to `consent.test.ts`**

```ts
import { createFadeTracker } from "./fade-tracker";
// ... (existing imports stay)

function depsWithFade(threadMessages: FlowletUIMessage[]) {
  return { ...deps(threadMessages), fadeTracker: createFadeTracker() };
}

describe("handleConsent — fade eligibility (ENG-193 §4.4)", () => {
  it("offers fadeEligible on the 3rd yes of the same shape for an act-tier tool", async () => {
    const d = depsWithFade(threadWith({}));
    for (const to of ["a@example.com", "b@example.com"]) {
      await handleConsent(d, scope, {
        threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
        response: { id: "call-1", decision: "yes" },
      });
    }
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes" },
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.fadeEligible?.proposalId).toBeTruthy();
  });

  it("never offers fadeEligible for a critical tool, even after repeated yeses", async () => {
    const d = depsWithFade(threadWith({ type: "tool-transfer_money", input: {} }));
    for (let i = 0; i < 3; i++) {
      await handleConsent(d, scope, {
        threadId: "th-1", toolCallId: "call-1", toolName: "transfer_money",
        response: { id: "call-1", decision: "no" }, // avoid the grant-refusal 403 path
      });
    }
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "transfer_money",
      response: { id: "call-1", decision: "no" },
    });
    expect(result.ok && result.fadeEligible).toBeUndefined();
  });

  it("no fadeEligible without a fadeTracker dependency (optional seam, no-op absent)", async () => {
    const d = deps(threadWith({}));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes" },
    });
    expect(result.ok && result.fadeEligible).toBeUndefined();
  });

  it("a 'no' decision records but never offers", async () => {
    const d = depsWithFade(threadWith({}));
    for (let i = 0; i < 5; i++) {
      const result = await handleConsent(d, scope, {
        threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
        response: { id: "call-1", decision: "no" },
      });
      expect(result.ok && result.fadeEligible).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run — FAIL** (`fadeTracker` not a recognized dep; `fadeEligible` not on the result type). `pnpm --filter @flowlet/runtime test -- consent.test.ts`

- [ ] **Step 3: Implement.** In `packages/flowlet-runtime/src/consent.ts`:

Add imports:

```ts
import type { FadeShape } from "@flowlet/core";
import type { FadeTracker } from "./fade-tracker";
import { dangerTier, isUnverified } from "./policy/tier";
```

Extend `HandleConsentDeps` (add, keep everything else):

```ts
export interface HandleConsentDeps {
  grants: GrantStore;
  audit: AuditLog;
  resolveDescriptor: (toolName: string) => ToolDescriptor | undefined;
  getMessages: (principal: Principal, threadId: string) => Promise<FlowletUIMessage[]>;
  /** ENG-193 §4.4 — optional (absent -> no fade tracking, the same graceful
   *  no-op every other optional seam in this codebase has). */
  fadeTracker?: FadeTracker;
  now?: () => string;
}
```

Extend the result type:

```ts
export type HandleConsentResult =
  | { ok: true; fadeEligible?: { shape: FadeShape; proposalId: string } }
  | { ok: false; status: 400 | 403 | 404; error: string };
```

In `handleConsent`, right after the toolName-match check passes (i.e., right before the existing `if (req.response.decision === "yes" && req.response.grant) { ... }` block), add the fade-tracking pass — it must run for EVERY well-formed decision, independent of whether a grant draft was attached:

```ts
  let fadeEligible: { shape: FadeShape; proposalId: string } | undefined;
  if (deps.fadeTracker) {
    const fadeDescriptor = deps.resolveDescriptor(req.toolName);
    // Fade eligibility is act-tier, verified-tool territory ONLY (ENG-193 §4.4
    // invariant — checked here structurally, not by convention: critical and
    // unverified tools never even reach `record`/`propose`).
    if (fadeDescriptor && dangerTier(fadeDescriptor) === "act" && !isUnverified(fadeDescriptor)) {
      const signal = req.response.decision === "no" ? "no" : "yes"; // "subset" reads as a yes
      deps.fadeTracker.record(principal, req.toolName, part.input, signal);
      if (signal === "yes") {
        const eligible = deps.fadeTracker.propose(principal, req.toolName, part.input);
        if (eligible) fadeEligible = eligible;
      }
    }
  }
```

Change the two `return audited({ok: true})` sites (there is one, at the bottom) to thread `fadeEligible` through:

```ts
  return audited({ ok: true, ...(fadeEligible ? { fadeEligible } : {}) });
```

(The existing `audited()` wrapper's own return type takes whatever `HandleConsentResult` is passed to it — no change needed there.)

- [ ] **Step 4: Run — PASS. Whole runtime package + `pnpm typecheck` — PASS. Commit** — `feat(runtime): handleConsent offers fadeEligible via FadeTracker (ENG-193 §4.4)`

---

### Task 5: `handleFadeProposal` — accept/decline, server re-derivation

**Files:**
- Create: `packages/flowlet-runtime/src/fade-proposal.ts`
- Test: `packages/flowlet-runtime/src/fade-proposal.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { handleFadeProposal } from "./fade-proposal";
import { createFadeTracker } from "./fade-tracker";
import { createInMemoryGrantStore } from "./grant-store";
import { InMemoryAuditLog } from "./embedded/in-memory-store";
import type { ToolDescriptor } from "./descriptor";

const scope = { tenantId: "t", subject: "u" };
const now = () => "2026-07-04T00:00:00Z";
const actDescriptor: ToolDescriptor = {
  name: "GMAIL_SEND_EMAIL", source: "composio", annotations: {}, hasExecute: true, kind: "function",
};
const criticalDescriptor: ToolDescriptor = {
  name: "transfer_money", source: "caller", annotations: { destructiveHint: true }, hasExecute: true, kind: "function",
};

function offerEligible(tracker = createFadeTracker()) {
  for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) {
    tracker.record(scope, "GMAIL_SEND_EMAIL", { to }, "yes");
  }
  return { tracker, offer: tracker.propose(scope, "GMAIL_SEND_EMAIL", { to: "d@acme.co" })! };
}

function deps(tracker = createFadeTracker(), resolveDescriptor = (n: string) =>
  n === "GMAIL_SEND_EMAIL" ? actDescriptor : n === "transfer_money" ? criticalDescriptor : undefined,
) {
  const grants = createInMemoryGrantStore({ now });
  const audit = new InMemoryAuditLog();
  return { fadeTracker: tracker, grants, audit, resolveDescriptor, now };
}

describe("handleFadeProposal", () => {
  it("accept mints a standing grant matching ONLY the derived shape", async () => {
    const { tracker, offer } = offerEligible();
    const d = deps(tracker);
    const result = await handleFadeProposal(d, scope, { proposalId: offer.proposalId, accept: true });
    expect(result.ok).toBe(true);
    const [grant] = await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL");
    expect(grant?.scope).toEqual({
      kind: "constrained", constraints: [{ path: "to", op: "matches", value: "*@acme.co" }],
    });
    expect(grant?.source).toEqual({ kind: "fade" });
    expect(await d.audit.query(scope, { kinds: ["grant_created"] })).toHaveLength(1);
    expect(await d.audit.query(scope, { kinds: ["consent"] })).toHaveLength(1);
  });

  it("decline stores a suppression and mints no grant", async () => {
    const { tracker, offer } = offerEligible();
    const d = deps(tracker);
    const result = await handleFadeProposal(d, scope, { proposalId: offer.proposalId, accept: false });
    expect(result.ok).toBe(true);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(0);
    expect(await d.audit.query(scope, { kinds: ["consent"] })).toHaveLength(1);
  });

  it("404s an unknown/expired proposalId", async () => {
    const d = deps();
    const result = await handleFadeProposal(d, scope, { proposalId: "not-real", accept: true });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(403); // resolveEligible returns undefined -> ineligible, not "not found" per se
  });

  it("INVARIANT: rejects a forged accept when the tracker's OWN state no longer supports it", async () => {
    const { tracker, offer } = offerEligible();
    tracker.record(scope, "GMAIL_SEND_EMAIL", { to: "z@acme.co" }, "no"); // sours it after the offer
    const d = deps(tracker);
    const result = await handleFadeProposal(d, scope, { proposalId: offer.proposalId, accept: true });
    expect(result.ok).toBe(false);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(0);
  });

  it("INVARIANT: refuses to mint for a tool whose LIVE descriptor is critical (defense in depth)", async () => {
    const tracker = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) {
      tracker.record(scope, "transfer_money", { to }, "yes");
    }
    const offer = tracker.propose(scope, "transfer_money", { to: "d@acme.co" })!;
    const d = deps(tracker);
    const result = await handleFadeProposal(d, scope, { proposalId: offer.proposalId, accept: true });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @flowlet/runtime test -- fade-proposal.test.ts`

- [ ] **Step 3: Implement**

```ts
/**
 * `handleFadeProposal` — resolves a fade proposal's accept/decline (ENG-193
 * §4.4). Mirrors `handleConsent`'s shape (transport-agnostic, audits every
 * decision) but is keyed by `proposalId`, not toolCallId/thread — a fade
 * proposal has neither (same reasoning as `ParkedActionResolution`).
 *
 * NEVER TRUSTS THE CLIENT: `accept: true` re-derives (tool, shape) from the
 * FadeTracker's OWN memory of what it offered and re-verifies eligibility is
 * STILL live right now — a forged accept for a stale, unknown, or
 * no-longer-eligible proposalId mints nothing. A second, redundant check
 * against the tool's LIVE descriptor tier (critical/unverified) guards
 * against the offer itself having been mis-gated — the same defense-in-depth
 * `grantManager.create` already applies at its own boundary.
 */
import type { AuditLog, FadeProposalResolution, GrantStore, Principal } from "@flowlet/core";
import type { ToolDescriptor } from "./descriptor";
import type { FadeTracker } from "./fade-tracker";
import { grantScopeFromShape } from "./policy/fade-shapes";
import { createGrantManager } from "./grant-manager";
import { dangerTier, isUnverified } from "./policy/tier";

export interface HandleFadeProposalDeps {
  fadeTracker: FadeTracker;
  grants: GrantStore;
  audit: AuditLog;
  resolveDescriptor: (toolName: string) => ToolDescriptor | undefined;
  now?: () => string;
}

export type HandleFadeProposalResult =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404; error: string };

export async function handleFadeProposal(
  deps: HandleFadeProposalDeps,
  principal: Principal,
  req: FadeProposalResolution,
): Promise<HandleFadeProposalResult> {
  const clock = deps.now ?? (() => new Date().toISOString());
  async function audited(result: HandleFadeProposalResult): Promise<HandleFadeProposalResult> {
    await deps.audit.append({
      at: clock(), principal, kind: "consent",
      consentId: req.proposalId, decision: req.accept ? "yes" : "no",
    });
    return result;
  }

  if (!req.accept) {
    const declined = deps.fadeTracker.decline(principal, req.proposalId);
    if (!declined) {
      return audited({ ok: false, status: 404, error: `unknown fade proposal "${req.proposalId}"` });
    }
    return audited({ ok: true });
  }

  const resolved = deps.fadeTracker.resolveEligible(principal, req.proposalId);
  if (!resolved) {
    return audited({
      ok: false, status: 403,
      error: `fade proposal "${req.proposalId}" is unknown or no longer eligible`,
    });
  }
  const descriptor = deps.resolveDescriptor(resolved.tool);
  if (!descriptor) {
    return audited({ ok: false, status: 404, error: `unknown tool "${resolved.tool}"` });
  }
  if (dangerTier(descriptor) === "critical" || isUnverified(descriptor)) {
    return audited({
      ok: false, status: 403,
      error: `refusing fade grant for "${resolved.tool}" — critical/unverified tools are never fadeable`,
    });
  }
  const manager = createGrantManager({ store: deps.grants, audit: deps.audit, now: clock });
  try {
    await manager.create(
      principal,
      {
        tool: resolved.tool,
        scope: grantScopeFromShape(resolved.shape),
        duration: "standing",
        source: { kind: "fade" },
      },
      descriptor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return audited({ ok: false, status: 403, error: message });
  }
  return audited({ ok: true });
}
```

- [ ] **Step 4: Run — PASS. Export `handleFadeProposal`/`HandleFadeProposalDeps`/`HandleFadeProposalResult` from `packages/flowlet-runtime/src/index.ts`. `pnpm typecheck` — PASS. Commit** — `feat(runtime): handleFadeProposal — server-re-derived accept/decline (ENG-193 §4.4)`

---

### Task 6: Automation audit completeness (diary prerequisite)

**Files:**
- Modify: `packages/flowlet-runtime/src/automations/runner.ts`
- Modify: `packages/flowlet-runtime/src/automations/runner.test.ts`

**Read first:** `runner.ts`'s `finalize()` (appends nothing to audit today) and `resolveParkedAction()`'s successful-execute branch (only appends a `"consent"` event, never `"tool_execution"` — `tool.execute` is called directly, bypassing `wrapTool`'s policy chain entirely). Both `automation_firing` and `tool_execution` are ALREADY declared in `@flowlet/core`'s `AuditEvent` union (unused until now) — no core schema change needed.

- [ ] **Step 1: Read `runner.test.ts`'s existing fixtures** for firing a run end-to-end and for `resolveParkedAction` — mirror their setup exactly (a fake `AutomationEngineStore`/tools/policy) rather than reinventing one.

- [ ] **Step 2: Write failing tests** (following the nearest existing fixture in each area):

```ts
it("ENG-193 §6.2: finalize() appends ONE automation_firing event per completed run (succeeded or failed)", async () => {
  // fire a real automation with an in-memory audit log wired into the runner's
  // `audit` config; assert exactly one { kind: "automation_firing", automationId, runId }
  // event after a succeeded run, and one after a run that fails.
});

it("ENG-193 §6.2: a skipped (guard=false) or cancelled (rate-capped) firing appends NO automation_firing event", async () => {
  // top-level guard false, and a maxFiringsPerHour-exceeding fire — assert
  // audit.query returns no automation_firing rows for either.
});

it("ENG-193 §6.2: resolveParkedAction appends a tool_execution event on a successful execute", async () => {
  // park an act-tier action, resolve it "approved", assert audit has
  // { kind: "tool_execution", toolName, mutating: true, dangerous: false, outcome: "ok" }.
});

it("ENG-193 §6.2: a critical parked action's resolved tool_execution is flagged dangerous: true", async () => {
  // same, with a destructiveHint: true tool — dangerous: true.
});

it("a FAILED parked-action execute appends NO tool_execution event (still unresolved, re-askable)", () => {
  // tool.execute resolves { ok: false, ... } — assert no tool_execution row and the
  // parked action stays unresolved (existing behavior), consistent with "only claim
  // success once the outcome is known".
});
```

- [ ] **Step 3: Run — FAIL.**

- [ ] **Step 4: Implement.** In `runner.ts`'s `finalize()`, right after `const finalized = await store.finalizeRun(scope, runId, input);`:

```ts
    await this.config.audit?.append({
      at: this.now(),
      principal: (this.config.auditPrincipal ?? ((s) => s))(scope),
      kind: "automation_firing",
      automationId: automation.id,
      runId: finalized.id,
    });
```

In `resolveParkedAction()`, right after `if (!outcome.ok) return { ok: false, error: outcome.error.message };` (i.e., execution is confirmed successful) and BEFORE `await this.config.store.resolveParkedAction(...)`:

```ts
      await this.config.audit?.append({
        at: this.now(),
        principal: (this.config.auditPrincipal ?? ((s) => s))(scope),
        kind: "tool_execution",
        toolName: action.tool,
        toolCallId: `parked-${action.id}`,
        mutating: true, // every parked action is a gated, non-read tool by construction
        dangerous: action.tier === "critical",
        outcome: "ok",
      });
```

- [ ] **Step 5: Run — PASS. Whole runtime package + `pnpm typecheck` — PASS. Commit** — `feat(runtime): wire automation_firing + parked tool_execution audit events (ENG-193 §6.2, diary prerequisite)`

---

### Task 7: `@flowlet/next` — fade-proposal route + fadeEligible passthrough

**Files:**
- Modify: `packages/flowlet-next/src/handler.ts`
- Modify: `packages/flowlet-next/src/consent.ts`
- Modify: `packages/flowlet-next/src/options.ts` (add `store.fadeTracker` override, mirroring `grants`/`audit`/`breakers`)
- Create: `packages/flowlet-next/src/fade-proposal.ts`
- Test: `packages/flowlet-next/src/fade-proposal.test.ts`, extend `consent.test.ts`

- [ ] **Step 1: Failing tests.** In `fade-proposal.test.ts`, mirror `consent.test.ts`'s route-level test shape (construct deps, POST-shaped body, assert `Response.json` status/payload) for `handleFadeProposalRoute`: malformed body -> 400; a real accept -> 200 `{ok:true}`; an ineligible proposalId -> the propagated status. In `consent.test.ts`, add: a POST whose underlying `handleConsent` result carries `fadeEligible` -> the route's JSON body includes `{ ok: true, fadeEligible: {...} }`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `fade-proposal.ts`** (mirrors `consent.ts`'s route adapter exactly):

```ts
/**
 * POST /api/flowlet/fade-proposal — the handler-side mount of the runtime's
 * `handleFadeProposal` (ENG-193 §4.4). Keyed by proposalId, not toolCallId —
 * see fade-proposal.ts's own docstring for why this isn't `/consent`.
 */
import { handleFadeProposal } from "@flowlet/runtime";
import type { ToolDescriptor } from "@flowlet/runtime";
import type { AuditLog, FadeTracker, GrantStore, Principal } from "@flowlet/core";
import { fadeProposalResolutionSchema } from "@flowlet/core";

export interface FadeProposalRouteDeps {
  fadeTracker: FadeTracker;
  grants: GrantStore;
  audit: AuditLog;
  resolveDescriptor: (toolName: string) => ToolDescriptor | undefined;
  principal: Principal;
}

export async function handleFadeProposalRoute(req: Request, deps: FadeProposalRouteDeps): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const parsed = fadeProposalResolutionSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "malformed fade-proposal request" }, { status: 400 });
  const result = await handleFadeProposal(
    { fadeTracker: deps.fadeTracker, grants: deps.grants, audit: deps.audit, resolveDescriptor: deps.resolveDescriptor },
    deps.principal,
    parsed.data,
  );
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true });
}
```

(If `FadeTracker` isn't exported from `@flowlet/core` — it's a runtime type, not a core one — import it from `@flowlet/runtime` instead: `import type { FadeTracker } from "@flowlet/runtime";`. Verify against Task 3/5's actual export location before writing the import.)

- [ ] **Step 4: Wire into `handler.ts`.** In `assemble()`, add beside `const grants = ...`:

```ts
    const fadeTracker = options.store?.fadeTracker ?? createFadeTracker();
```

(import `createFadeTracker` from `@flowlet/runtime`). Return it from `assemble()`'s object (`fadeTracker,`). In `handleConsentRoute`'s call site (the `case "consent":` branch), add `fadeTracker: s.fadeTracker` to the deps object. Add a new case to `POST`'s switch:

```ts
      case "fade-proposal": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return handleFadeProposalRoute(req, {
          fadeTracker: s.fadeTracker,
          grants: s.grants,
          audit: s.audit,
          resolveDescriptor: s.resolveDescriptor,
          principal: { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId },
        });
      }
```

Update the module docstring's endpoint list to add `POST /fade-proposal — resolves a fade proposal (ENG-193 §4.4)`.

- [ ] **Step 5: Update `consent.ts`'s route** to add `fadeTracker` to `ConsentRouteDeps` and pass it into `handleConsent`'s deps, and propagate the result:

```ts
  const result = await handleConsent(
    { grants: deps.grants, audit: deps.audit, resolveDescriptor: deps.resolveDescriptor,
      getMessages: (scope, id) => deps.threads.getMessages(scope, id),
      fadeTracker: deps.fadeTracker },
    deps.principal,
    { threadId, toolCallId: body.toolCallId, toolName: body.toolName, response: parsedResponse.data },
  );
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true, ...(result.fadeEligible ? { fadeEligible: result.fadeEligible } : {}) });
```

- [ ] **Step 6: `options.ts`** — add `fadeTracker?: FadeTracker` to the `store` option's type and its zod schema (mirror the existing `breakers` line exactly: `fadeTracker: z.custom<FadeTracker>((v) => typeof v === "object" && v !== null).optional(),`).

- [ ] **Step 7: Run — PASS. Whole `@flowlet/next` package + `pnpm typecheck` — PASS. Commit** — `feat(next): fade-proposal route + fadeEligible passthrough on /consent (ENG-193 §4.4)`

---

### Task 8: `@flowlet/next` — Trust screen endpoints (grants, revoke, audit, critical-tools)

**Files:**
- Create: `packages/flowlet-next/src/trust.ts`
- Modify: `packages/flowlet-next/src/handler.ts`
- Test: `packages/flowlet-next/src/trust.test.ts`

- [ ] **Step 1: Failing tests.** Cover, at minimum:
  - `listGrantsRoute` returns standing `GrantStore` rows shaped `{ id, tool, scopePreview, since, source }` AND, when a world exists with an enabled automation whose current version has grants, ALSO synthetic `{ tool, scopePreview, since, source: "automation", automationName }` rows with no `id` (not individually revokable).
  - `revokeGrantRoute` calls `grantManager.revoke` and 404s an unknown/foreign grant id.
  - `queryAuditRoute` honors `?sinceMs=` and returns rows newest-first (delegates straight to `AuditLog.query`).
  - `listCriticalToolsRoute` returns only tools whose live descriptor is `dangerTier === "critical"`, across host tools + server tools + (if present) the automation world's authoring tools, each as `{ name }` — no host-tool config or description details required for the wire shape.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `trust.ts`**

```ts
/**
 * The Trust screen's read/write endpoints (ENG-193 §3 Moment 12/§4.3/§6.2):
 * GET /grants (federated — standing GrantStore rows + read-only automation-
 * version rows, per spec §4.3's own federation language), POST /grants/revoke,
 * GET /audit (query), GET /critical-tools (static per-request, no store).
 * Thin adapters over the runtime/store primitives, following consent.ts's
 * own pattern in this package.
 */
import type { AuditLog, GrantStore, Principal } from "@flowlet/core";
import { createGrantManager, dangerTier, type ToolDescriptor } from "@flowlet/runtime";
import type { FlowletAutomationsWorld } from "./world";

export interface TrustGrantRow {
  id?: string;
  tool: string;
  scopePreview: string;
  since: string;
  source: "chat" | "fade" | "compiled-rule" | "automation";
  automationName?: string;
}

function scopePreview(scope: { kind: string; constraints?: { path: string; op: string; value: unknown }[]; inputPreview?: string }): string {
  if (scope.kind === "tool") return "any input";
  if (scope.kind === "exact") return `exactly: ${scope.inputPreview}`;
  return (scope.constraints ?? []).map((c) => `${c.path} ${c.op} ${JSON.stringify(c.value)}`).join(" AND ");
}

export async function listGrantsRoute(
  _req: Request,
  deps: { grants: GrantStore; world: FlowletAutomationsWorld | null; principal: Principal },
): Promise<Response> {
  const standing = await deps.grants.list(deps.principal);
  const rows: TrustGrantRow[] = standing
    .filter((g) => g.revokedAt === undefined)
    .map((g) => ({
      id: g.id, tool: g.tool, scopePreview: scopePreview(g.scope),
      since: g.grantedAt, source: g.source.kind,
    }));

  if (deps.world) {
    const automations = await deps.world.store.list(deps.principal);
    for (const automation of automations) {
      const version = await deps.world.store.getVersion(deps.principal, automation.id, automation.currentVersion);
      for (const grant of version?.grants ?? []) {
        rows.push({
          tool: grant.tool, scopePreview: "runs as agreed",
          since: grant.grantedAt, source: "automation", automationName: automation.name,
        });
      }
    }
  }
  return Response.json({ grants: rows });
}

export async function revokeGrantRoute(
  req: Request,
  deps: { grants: GrantStore; audit: AuditLog; principal: Principal },
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const id = typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : undefined;
  if (!id) return Response.json({ error: "malformed revoke request" }, { status: 400 });
  const existing = (await deps.grants.list(deps.principal)).find((g) => g.id === id && g.revokedAt === undefined);
  if (!existing) return Response.json({ error: `no live grant "${id}"` }, { status: 404 });
  await createGrantManager({ store: deps.grants, audit: deps.audit }).revoke(deps.principal, id);
  return Response.json({ ok: true });
}

export async function queryAuditRoute(
  req: Request,
  deps: { audit: AuditLog; principal: Principal },
): Promise<Response> {
  const url = new URL(req.url);
  const sinceMs = url.searchParams.get("sinceMs");
  const limit = url.searchParams.get("limit");
  const rows = await deps.audit.query(deps.principal, {
    ...(sinceMs ? { since: new Date(Number(sinceMs)).toISOString() } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
  });
  return Response.json({ events: rows });
}

export async function listCriticalToolsRoute(
  _req: Request,
  deps: { toolNames: string[]; resolveDescriptor: (name: string) => ToolDescriptor | undefined },
): Promise<Response> {
  const tools = [...new Set(deps.toolNames)]
    .map((name) => ({ name, descriptor: deps.resolveDescriptor(name) }))
    .filter((t): t is { name: string; descriptor: ToolDescriptor } => t.descriptor !== undefined)
    .filter((t) => dangerTier(t.descriptor) === "critical")
    .map((t) => ({ name: t.name }));
  return Response.json({ tools });
}
```

- [ ] **Step 4: Wire into `handler.ts`.** Add to `GET`'s switch:

```ts
      case "grants":
        return listGrantsRoute(req, { grants: s.grants, world: s.world, principal: /* resolved below */ });
      case "audit": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return queryAuditRoute(req, { audit: s.audit, principal: { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId } });
      }
      case "critical-tools": {
        const names = [
          ...Object.keys(clientTools /* the resolver's own closure variable — hoist it to `state()` if not already returned */),
          ...Object.keys(s.serverTools()),
          ...(s.world ? Object.keys(s.world.authoringTools()) : []),
        ];
        return listCriticalToolsRoute(req, { toolNames: names, resolveDescriptor: s.resolveDescriptor });
      }
```

`grants` and `critical-tools` need a principal guard too (copy the `audit` case's `resolvePrincipal` pattern into both — omitted above only for brevity; every GET here must guard). `clientTools` is currently a local `const` inside `assemble()`'s closure, not returned on the state object — add it to the returned object (`clientTools,`) so the route handler above can read it via `s.clientTools`. Add `POST /grants/revoke` to `POST`'s switch, guarded the same way as `consent`/`resolve`:

```ts
      case "revoke": { // subPath === "revoke" for POST /grants/revoke
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return revokeGrantRoute(req, { grants: s.grants, audit: s.audit, principal: { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId } });
      }
```

Double-check `subPath`'s "last segment only" behavior (already true for `resolve` under `parked-actions/resolve`) resolves `grants/revoke` to `"revoke"` correctly — it does, by the same mechanism.

Update the module docstring's endpoint list with the four new lines.

- [ ] **Step 5: Run — PASS. Whole package + `pnpm typecheck` — PASS. Commit** — `feat(next): Trust screen endpoints — grants (federated), revoke, audit query, critical-tools (ENG-193 §3 Moment 12)`

---

### Task 9: Accounting demo — parallel wiring

**Files:**
- Modify: `apps/demo-accounting/src/flowlet/store.ts` (add `fadeTracker: FadeTracker` to `DemoStore`)
- Modify: `apps/demo-accounting/src/flowlet/consent-handler.ts` (thread `fadeTracker`, propagate `fadeEligible`)
- Create: `apps/demo-accounting/src/flowlet/fade-proposal-handler.ts`
- Create: `apps/demo-accounting/src/flowlet/trust-handler.ts`
- Create app routes: `apps/demo-accounting/src/app/api/flowlet/fade-proposal/route.ts`, `.../grants/route.ts`, `.../grants/revoke/route.ts`, `.../audit/route.ts`, `.../critical-tools/route.ts`
- Test: `apps/demo-accounting/src/flowlet/fade-proposal-handler.test.ts`, `trust-handler.test.ts`

- [ ] **Step 1: `store.ts`** — add `fadeTracker: createFadeTracker()` to `demoStore`'s initializer and `fadeTracker: FadeTracker` to the `DemoStore` interface. In `resetDemoStore()`, note in a comment that fade state is intentionally NOT reset (matches "audit log intentionally survives resets" — a fresh take should still show fades already learned this session as a demo feature, not a bug; flip this if the runbook wants a clean-slate reset instead — flag for Yousef at review since this is a demo-choreography call, not an architecture one).

- [ ] **Step 2: `consent-handler.ts`** — add `fadeTracker: demoStore.fadeTracker` to the `handleConsent` deps object; change the final success return to `return Response.json({ ok: true, ...(result.fadeEligible ? { fadeEligible: result.fadeEligible } : {}) });`.

- [ ] **Step 3: `fade-proposal-handler.ts`** (mirrors `consent-handler.ts`):

```ts
/**
 * POST /api/flowlet/fade-proposal — mounts `handleFadeProposal` (ENG-193
 * §4.4) behind this app's own hand-rolled route, same pattern as
 * consent-handler.ts.
 */
import { handleFadeProposal } from "@flowlet/runtime";
import { fadeProposalResolutionSchema } from "@flowlet/core";
import { demoStore, CADENCE_SCOPE } from "./store";
import { resolveToolDescriptor } from "./tool-registry";
import { demoPrincipalAllowed, LOCAL_ONLY_MESSAGE } from "./local-guard";

export async function handleDemoFadeProposal(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const parsed = fadeProposalResolutionSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "malformed fade-proposal request" }, { status: 400 });
  const result = await handleFadeProposal(
    {
      fadeTracker: demoStore.fadeTracker, grants: demoStore.grants, audit: demoStore.audit,
      resolveDescriptor: resolveToolDescriptor,
    },
    CADENCE_SCOPE,
    parsed.data,
  );
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true });
}
```

- [ ] **Step 4: `trust-handler.ts`** (mirrors `parked-actions-handler.ts`'s bundling of related routes into one file):

```ts
/**
 * GET /api/flowlet/grants, POST /api/flowlet/grants/revoke,
 * GET /api/flowlet/audit, GET /api/flowlet/critical-tools (ENG-193 §3 Moment
 * 12/§4.3/§6.2) — the Trust screen's data plane, mounted behind this app's
 * own hand-rolled routes.
 */
import { createGrantManager, dangerTier } from "@flowlet/runtime";
import { demoStore, CADENCE_SCOPE } from "./store";
import { automationsWorld } from "./automations";
import { cadenceHostToolDefs } from "./host-tools";
import { hostToolset } from "@flowlet/runtime";
import { resolveToolDescriptor } from "./tool-registry";
import { demoPrincipalAllowed, LOCAL_ONLY_MESSAGE } from "./local-guard";

function scopePreview(scope: { kind: string; constraints?: { path: string; op: string; value: unknown }[]; inputPreview?: string }): string {
  if (scope.kind === "tool") return "any input";
  if (scope.kind === "exact") return `exactly: ${scope.inputPreview}`;
  return (scope.constraints ?? []).map((c) => `${c.path} ${c.op} ${JSON.stringify(c.value)}`).join(" AND ");
}

export async function handleDemoGrantsList(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  const standing = await demoStore.grants.list(CADENCE_SCOPE);
  const rows = standing.filter((g) => g.revokedAt === undefined).map((g) => ({
    id: g.id, tool: g.tool, scopePreview: scopePreview(g.scope), since: g.grantedAt, source: g.source.kind,
  }));
  const automations = await automationsWorld().store.list(CADENCE_SCOPE);
  for (const automation of automations) {
    const version = await automationsWorld().store.getVersion(CADENCE_SCOPE, automation.id, automation.currentVersion);
    for (const grant of version?.grants ?? []) {
      rows.push({
        id: undefined, tool: grant.tool, scopePreview: "runs as agreed",
        since: grant.grantedAt, source: "automation", automationName: automation.name,
      } as never);
    }
  }
  return Response.json({ grants: rows });
}

export async function handleDemoGrantsRevoke(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const id = typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : undefined;
  if (!id) return Response.json({ error: "malformed revoke request" }, { status: 400 });
  const existing = (await demoStore.grants.list(CADENCE_SCOPE)).find((g) => g.id === id && g.revokedAt === undefined);
  if (!existing) return Response.json({ error: `no live grant "${id}"` }, { status: 404 });
  await createGrantManager({ store: demoStore.grants, audit: demoStore.audit }).revoke(CADENCE_SCOPE, id);
  return Response.json({ ok: true });
}

export async function handleDemoAuditQuery(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  const url = new URL(req.url);
  const sinceMs = url.searchParams.get("sinceMs");
  const limit = url.searchParams.get("limit");
  const rows = await demoStore.audit.query(CADENCE_SCOPE, {
    ...(sinceMs ? { since: new Date(Number(sinceMs)).toISOString() } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
  });
  return Response.json({ events: rows });
}

const hostTools = hostToolset(cadenceHostToolDefs);

export async function handleDemoCriticalTools(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  const names = [...new Set([...Object.keys(hostTools), ...Object.keys(automationsWorld().authoringTools())])];
  const tools = names
    .map((name) => ({ name, descriptor: resolveToolDescriptor(name) }))
    .filter((t): t is { name: string; descriptor: NonNullable<ReturnType<typeof resolveToolDescriptor>> } => t.descriptor !== undefined)
    .filter((t) => dangerTier(t.descriptor) === "critical")
    .map((t) => ({ name: t.name }));
  return Response.json({ tools });
}
```

- [ ] **Step 5: App routes** — five thin files, each following the existing `route.ts` one-liner pattern (`export const runtime = "nodejs"; export const dynamic = "force-dynamic";` + a single exported method calling the handler). Example (`grants/route.ts`):

```ts
/** GET /api/flowlet/grants — see trust-handler.ts. */
import { handleDemoGrantsList } from "@/flowlet/trust-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handleDemoGrantsList(req);
}
```

Repeat for `grants/revoke` (POST → `handleDemoGrantsRevoke`), `audit` (GET → `handleDemoAuditQuery`), `critical-tools` (GET → `handleDemoCriticalTools`), `fade-proposal` (POST → `handleDemoFadeProposal`).

- [ ] **Step 6: Tests** for `fade-proposal-handler.ts`/`trust-handler.ts`, mirroring `consent-handler.test.ts`'s/`parked-actions-handler.test.ts`'s existing shape (read them first) — construct a `Request`, assert status/body for the happy path, a malformed body, and (for revoke) an unknown id.

- [ ] **Step 7: Run — PASS. `pnpm --filter demo-accounting typecheck` (or the repo-root `pnpm typecheck`) — PASS. Commit** — `feat(demo-accounting): parallel fade-proposal + Trust-screen route wiring (ENG-193 §3 Moment 12/§4.4)`

---

### Task 10: Shell seam — `sendConsent` result + `TrustSeam`

**Files:**
- Modify: `packages/flowlet-shell/src/context.tsx`
- Test: `packages/flowlet-shell/src/context.test.tsx` (extend if it exists; else a focused new test asserting the provider passes `trust`/widened `sendConsent` through unchanged)

- [ ] **Step 1: Failing test** (asserting the new context shape is threaded through `useShell()`):

```tsx
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FlowletShellProvider, useShell } from "./context";

function Probe({ onRead }: { onRead: (v: unknown) => void }) {
  onRead(useShell());
  return null;
}

describe("ShellContextValue — trust seam (ENG-193 §3 Moment 12)", () => {
  it("passes `trust` through untouched, defaulting to undefined", () => {
    let seen: { trust?: unknown } | undefined;
    render(
      <FlowletShellProvider>
        <Probe onRead={(v) => { seen = v as { trust?: unknown }; }} />
      </FlowletShellProvider>,
    );
    expect(seen?.trust).toBeUndefined();
  });

  it("passes a supplied `trust` object through", () => {
    const trust = {
      listGrants: async () => [], revokeGrant: async () => {}, queryAudit: async () => [],
      listCriticalTools: async () => [], resolveFadeProposal: async () => {},
    };
    let seen: { trust?: unknown } | undefined;
    render(
      <FlowletShellProvider trust={trust}>
        <Probe onRead={(v) => { seen = v as { trust?: unknown }; }} />
      </FlowletShellProvider>,
    );
    expect(seen?.trust).toBe(trust);
  });
});
```

- [ ] **Step 2: Run — FAIL** (props don't exist yet). `pnpm --filter @flowlet/shell test -- context.test.tsx`

- [ ] **Step 3: Implement.** In `context.tsx`, add (near `ParkedActionsSeam`):

```ts
/** Trust-screen data plane (ENG-193 §3 Moment 12): mirrors `ParkedActionsSeam`'s
 *  pattern exactly. Absent -> `useTrustData` reports empty everything, no
 *  polling — the same graceful no-op every other optional seam here has. */
export interface TrustGrantRow {
  /** Absent for automation-federated rows — not individually revokable from
   *  here (spec: "read-only + link hint"). */
  id?: string;
  tool: string;
  scopePreview: string;
  since: string;
  source: "chat" | "fade" | "compiled-rule" | "automation";
  automationName?: string;
}
export interface TrustAuditRow {
  at: string;
  kind: string;
  toolName?: string;
  mutating?: boolean;
  dangerous?: boolean;
}
export interface TrustSeam {
  listGrants: () => Promise<TrustGrantRow[]>;
  revokeGrant: (id: string) => Promise<void>;
  queryAudit: (opts: { sinceMs: number }) => Promise<TrustAuditRow[]>;
  listCriticalTools: () => Promise<{ name: string }[]>;
  resolveFadeProposal: (proposalId: string, accept: boolean) => Promise<void>;
}

/** What `sendConsent` resolves with (ENG-193 §4.4 addition — additive:
 *  existing `Promise<void>`-returning implementations stay assignable). */
export interface SendConsentResult {
  fadeEligible?: { shape: import("@flowlet/core").FadeShape; proposalId: string };
}
```

Widen `sendConsent`'s type on BOTH `ShellContextValue` and `FlowletShellProviderProps`:

```ts
  sendConsent?: (
    response: import("@flowlet/core").ConsentResponse,
    meta: { toolName: string },
  ) => Promise<SendConsentResult | void>;
```

Add `trust?: TrustSeam;` to both interfaces, thread it through the `useMemo` deps list and the destructured props in `FlowletShellProvider` exactly like `parkedActions` is today (add `trust` to the prop list, the memo's object, and its dependency array).

- [ ] **Step 4: Run — PASS. `pnpm typecheck` — PASS. Commit** — `feat(shell): widen sendConsent result + add TrustSeam context (ENG-193 §3 Moment 12/§4.4)`

---

### Task 11: `FadeProposalCard` + `FlowletThread`/`MessageList` wiring

**Files:**
- Create: `packages/flowlet-shell/src/components/FadeProposalCard.tsx`
- Modify: `packages/flowlet-shell/src/components/MessageList.tsx`
- Modify: `packages/flowlet-shell/src/FlowletThread.tsx`
- Modify: `packages/flowlet-shell/src/index.ts` (export `FadeProposalCard`)
- Modify: `packages/flowlet-shell/src/styles.css` (`.fl-fade*`)
- Test: `packages/flowlet-shell/src/components/fade-proposal-card.test.tsx`, extend `message-list.test.tsx`/`FlowletThread` tests if present

- [ ] **Step 1: Failing component test**

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FadeProposalCard } from "./FadeProposalCard";

describe("FadeProposalCard (ENG-193 §3 Moment 5)", () => {
  it("renders the proposal copy and both actions", () => {
    render(<FadeProposalCard toolName="GMAIL_SEND_EMAIL" onAccept={() => {}} onDecline={() => {}} />);
    expect(screen.getByText(/third time/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sounds good/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /keep asking/i })).toBeInTheDocument();
  });
  it("fires onAccept/onDecline", () => {
    const onAccept = vi.fn(), onDecline = vi.fn();
    render(<FadeProposalCard toolName="GMAIL_SEND_EMAIL" onAccept={onAccept} onDecline={onDecline} />);
    fireEvent.click(screen.getByRole("button", { name: /sounds good/i }));
    fireEvent.click(screen.getByRole("button", { name: /keep asking/i }));
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onDecline).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `FadeProposalCard.tsx`**

```tsx
import { toolAction } from "./tool-labels";

export interface FadeProposalCardProps {
  toolName: string;
  onAccept: () => void;
  onDecline: () => void;
}

/**
 * The fade proposal (spec §3 Moment 5): "that's the third time you've
 * okayed this — want me to handle these without checking?" Plain yes/no,
 * quieter register than `ApprovalCard` (this ISN'T another ask, it's an
 * offer to stop asking) — its own dashed "learning" visual identity.
 */
export function FadeProposalCard({ toolName, onAccept, onDecline }: FadeProposalCardProps) {
  const action = toolAction(toolName);
  return (
    <div className="fl-fade" role="group" aria-label="Handle this without asking?">
      <div className="fl-fade-text">
        That's the third time you've okayed {action.request.toLowerCase()} — want me to handle these without checking?
      </div>
      <div className="fl-fade-actions">
        <button type="button" className="fl-btn fl-btn-primary" onClick={onAccept}>Sounds good</button>
        <button type="button" className="fl-btn" onClick={onDecline}>Keep asking</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire into `MessageList.tsx`.** Add props:

```ts
  /** A pending fade proposal for the turn (ENG-193 §3 Moment 5) — renders
   *  right after that turn's activity panel. Null/absent -> nothing renders. */
  fadeProposal?: { messageId: string; toolName: string } | null;
  onAcceptFade?: () => void;
  onDeclineFade?: () => void;
```

Change the `"activity"` case from returning `<ActivityPanel .../>` directly to a wrapping fragment that also renders the card when the messageId matches:

```tsx
            case "activity":
              return (
                <div key={item.key} className="fl-activity-slot">
                  <ActivityPanel
                    steps={item.steps}
                    working={status !== "ready" && status !== "error" && item === rendered[rendered.length - 1]}
                  />
                  {fadeProposal && fadeProposal.messageId === item.messageId && (
                    <FadeProposalCard
                      toolName={fadeProposal.toolName}
                      onAccept={() => onAcceptFade?.()}
                      onDecline={() => onDeclineFade?.()}
                    />
                  )}
                </div>
              );
```

(`.fl-activity-slot` is a plain block wrapper — add a one-line CSS rule if the extra `div` disturbs existing spacing; check visually in Task 16.)

- [ ] **Step 5: Wire into `FlowletThread.tsx`.** Add state:

```ts
  const [fadeProposal, setFadeProposal] = useState<{ messageId: string; toolName: string; proposalId: string } | null>(null);
```

Pull `trust` from `useShell()` too: `const { integrations, sendConsent, trust } = useShell();`. Change `postConsent` to propagate the resolved value instead of discarding it:

```ts
  const postConsent = (response: ConsentResponse, toolName: string) =>
    sendConsent ? sendConsent(response, { toolName }).catch(() => undefined) : Promise.resolve(undefined);
```

In `approve`, capture `fadeEligible` and stash it against the approval's `messageId`:

```ts
  const approve = (approvalId: string) => {
    const item = findApproval(approvalId);
    const consentPost = item?.toolCallId
      ? postConsent({ id: item.toolCallId, decision: "yes" }, item.toolName)
      : Promise.resolve(undefined);
    void consentPost.then((result) => {
      if (result?.fadeEligible && item) {
        setFadeProposal({ messageId: item.messageId, toolName: item.toolName, proposalId: result.fadeEligible.proposalId });
      }
      chat.addToolApprovalResponse({ id: approvalId, approved: true });
    });
  };
```

Add resolve handlers and pass everything into `MessageList`:

```ts
  const resolveFade = (accept: boolean) => {
    if (!fadeProposal) return;
    const { proposalId } = fadeProposal;
    setFadeProposal(null);
    void trust?.resolveFadeProposal(proposalId, accept);
  };
```

```tsx
          <MessageList
            items={chat.items}
            status={chat.status}
            onApprove={approve}
            onDecline={decline}
            onApproveBatch={approveBatch}
            onApproveSubset={approveSubset}
            onDeclineBatch={declineBatch}
            onRegenerate={regenerate}
            onFeedback={onFeedback}
            fadeProposal={fadeProposal}
            onAcceptFade={() => resolveFade(true)}
            onDeclineFade={() => resolveFade(false)}
          />
```

- [ ] **Step 6: CSS** — add to `styles.css` near the approval-card block:

```css
/* ---------- fade proposal (ENG-193 §3 Moment 5/§4.4) ---------- */
.fl-fade { display: flex; flex-direction: column; gap: 10px; margin: 6px 0; padding: 12px 14px;
  border: 1px dashed var(--flowlet-border); border-radius: 12px; background: var(--flowlet-accent-soft); }
.fl-fade-text { font-size: 13px; line-height: 1.4; color: var(--flowlet-fg); }
.fl-fade-actions { display: flex; gap: 8px; }
```

(Confirm `--flowlet-accent-soft` already exists in `styles.css`'s var list before using it verbatim — it's referenced elsewhere in the file per the grep in this plan's research; if the exact token name differs, use the nearest existing muted-accent var.)

- [ ] **Step 7: Run — PASS. `pnpm --filter @flowlet/shell test` + `pnpm typecheck` — PASS. Commit** — `feat(shell): FadeProposalCard + thread wiring (ENG-193 §3 Moment 5)`

---

### Task 12: `useTrustData` hook

**Files:**
- Create: `packages/flowlet-shell/src/use-trust-data.ts`
- Modify: `packages/flowlet-shell/src/index.ts`
- Test: `packages/flowlet-shell/src/use-trust-data.test.ts`

- [ ] **Step 1: Failing tests** (mirror `use-parked-actions.test.ts`'s render-hook + fake-timer polling pattern — read it first):

```ts
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTrustData } from "./use-trust-data";
import { FlowletShellProvider } from "./context";
import type { TrustAuditRow, TrustGrantRow } from "./context";

function wrapper(trust: Parameters<typeof FlowletShellProvider>[0]["trust"]) {
  return ({ children }: { children: React.ReactNode }) =>
    <FlowletShellProvider trust={trust}>{children}</FlowletShellProvider>;
}

describe("useTrustData", () => {
  it("empty/no-op when trust is absent", async () => {
    const { result } = renderHook(() => useTrustData(), { wrapper: wrapper(undefined) });
    expect(result.current.grants).toEqual([]);
    expect(result.current.diary.total).toBe(0);
  });

  it("splits standing grants from automation-federated rows", async () => {
    const grants: TrustGrantRow[] = [
      { id: "g1", tool: "send_email", scopePreview: "to matches *@acme.co", since: "2026-07-01T00:00:00Z", source: "fade" },
      { tool: "GMAIL_SEND_EMAIL", scopePreview: "runs as agreed", since: "2026-07-01T00:00:00Z", source: "automation", automationName: "Morning chase" },
    ];
    const trust = {
      listGrants: async () => grants, revokeGrant: async () => {}, queryAudit: async (): Promise<TrustAuditRow[]> => [],
      listCriticalTools: async () => [], resolveFadeProposal: async () => {},
    };
    const { result } = renderHook(() => useTrustData(), { wrapper: wrapper(trust) });
    await waitFor(() => expect(result.current.grants).toHaveLength(1));
    expect(result.current.automationGrants).toHaveLength(1);
    expect(result.current.automationGrants[0]?.automationName).toBe("Morning chase");
  });

  it("summarizes the diary from audit rows (reads/approved/automation runs/money moves)", async () => {
    const rows: TrustAuditRow[] = [
      { at: "1", kind: "tool_execution", toolName: "get_x", mutating: false },
      { at: "2", kind: "tool_execution", toolName: "send_email", mutating: true, dangerous: false },
      { at: "3", kind: "tool_execution", toolName: "transfer_money", mutating: true, dangerous: true },
      { at: "4", kind: "automation_firing" },
    ];
    const trust = {
      listGrants: async () => [], revokeGrant: async () => {}, queryAudit: async () => rows,
      listCriticalTools: async () => [], resolveFadeProposal: async () => {},
    };
    const { result } = renderHook(() => useTrustData(), { wrapper: wrapper(trust) });
    await waitFor(() => expect(result.current.diary.total).toBe(3)); // 1 read + 1 approved + 1 automation run
    expect(result.current.diary).toMatchObject({ reads: 1, approved: 1, automationRuns: 1, moneyMoves: 1 });
  });

  it("revoke calls trust.revokeGrant and refreshes", async () => {
    const revokeGrant = vi.fn().mockResolvedValue(undefined);
    const listGrants = vi.fn().mockResolvedValue([]);
    const trust = { listGrants, revokeGrant, queryAudit: async () => [], listCriticalTools: async () => [], resolveFadeProposal: async () => {} };
    const { result } = renderHook(() => useTrustData(), { wrapper: wrapper(trust) });
    await result.current.revoke("g1");
    expect(revokeGrant).toHaveBeenCalledWith("g1");
    expect(listGrants).toHaveBeenCalledTimes(2); // initial + post-revoke refresh
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

```ts
/**
 * useTrustData — the Trust screen's data plane (ENG-193 §3 Moment 12/§4.3/
 * §6.2). Mirrors `useParkedActions`' seam pattern exactly: polls while
 * mounted, absent `trust` seam -> empty/no-op, the host wires real fetchers
 * (see @flowlet/next's catch-all and the accounting demo's trust-handler.ts).
 * The diary (§3 Moment 10) is summarized CLIENT-SIDE from the last 7 days of
 * audit rows — no server-side diary concept exists; `automation_firing` is
 * counted at FIRING granularity (one per run), not per tool call inside a
 * run (see this plan's Task 6 / deviation #5).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useShell } from "./context";
import { useParkedActions } from "./use-parked-actions";
import type { TrustAuditRow, TrustGrantRow } from "./context";

const POLL_MS = 30_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface DiaryData {
  total: number;
  reads: number;
  approved: number;
  automationRuns: number;
  moneyMoves: number;
}

function summarize(rows: TrustAuditRow[]): DiaryData {
  let reads = 0, approved = 0, automationRuns = 0, moneyMoves = 0;
  for (const row of rows) {
    if (row.kind === "tool_execution") {
      if (row.mutating === false) reads += 1;
      else if (row.dangerous === true) moneyMoves += 1;
      else approved += 1;
    } else if (row.kind === "automation_firing") {
      automationRuns += 1;
    }
  }
  return { total: reads + approved + automationRuns, reads, approved, automationRuns, moneyMoves };
}

export function useTrustData() {
  const { trust } = useShell();
  const parked = useParkedActions();
  const [grants, setGrants] = useState<TrustGrantRow[]>([]);
  const [criticalTools, setCriticalTools] = useState<{ name: string }[]>([]);
  const [activity, setActivity] = useState<TrustAuditRow[]>([]);
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    if (!trust) return;
    void trust.listGrants().then((rows) => { if (mounted.current) setGrants(rows); });
    void trust.listCriticalTools().then((rows) => { if (mounted.current) setCriticalTools(rows); });
    void trust.queryAudit({ sinceMs: Date.now() - WEEK_MS }).then((rows) => { if (mounted.current) setActivity(rows); });
  }, [trust]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    if (!trust) return undefined;
    const id = setInterval(refresh, POLL_MS);
    return () => { mounted.current = false; clearInterval(id); };
  }, [refresh, trust]);

  const revoke = (id: string) => (trust ? trust.revokeGrant(id).then(refresh) : Promise.resolve());

  return {
    grants: grants.filter((g) => g.source !== "automation"),
    automationGrants: grants.filter((g) => g.source === "automation"),
    criticalTools,
    activity,
    diary: summarize(activity),
    parked,
    revoke,
    refresh,
  };
}
```

- [ ] **Step 4: Run — PASS.** Export from `packages/flowlet-shell/src/index.ts` (`export * from "./use-trust-data";`). `pnpm typecheck` — PASS. Commit — `feat(shell): useTrustData hook — federated grants + client-side diary (ENG-193 §3 Moment 10/12)`

---

### Task 13: `TrustScreen` component

**Files:**
- Create: `packages/flowlet-shell/src/components/TrustScreen.tsx`
- Modify: `packages/flowlet-shell/src/index.ts`
- Modify: `packages/flowlet-shell/src/styles.css` (`.fl-trust*`)
- Test: `packages/flowlet-shell/src/components/trust-screen.test.tsx`

- [ ] **Step 1: Failing tests** — render with a stubbed `trust` seam (fixtures matching Task 12's) and assert: the five section headings render; a grant with an `id` shows an "Ask me again" button that calls `trust.revokeGrant`; an automation-sourced row shows no such button; the diary sentence renders with the right numbers; `onClose` fires from the close control.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

```tsx
/**
 * TrustScreen (spec §3 Moment 12) — behind a quiet shield icon. Five
 * sections: what's handled without asking, what automations run
 * unattended (read-only, federated), what always needs the human
 * (critical tools, can't be changed), what's waiting, and the weekly
 * plain-English activity/diary. Seams: `useTrustData` (mirrors
 * `useParkedActions` exactly).
 */
import { useTrustData } from "../use-trust-data";
import { toolAction } from "./tool-labels";
import { WaitingList } from "./WaitingList";
import { relativeTimeLabel } from "../relative-time";
import type { TrustAuditRow } from "../context";

export interface TrustScreenProps {
  onClose: () => void;
}

function auditLine(row: TrustAuditRow): string {
  switch (row.kind) {
    case "tool_execution":
      return row.dangerous ? `${toolAction(row.toolName ?? "").done} — a money move` : toolAction(row.toolName ?? "").done;
    case "automation_firing":
      return "An automation ran";
    case "grant_created":
      return "Started handling something without asking";
    case "grant_revoked":
      return "Asked to check again on something";
    case "judge_escalation":
      return "Stopped to check something unusual";
    case "consent":
      return "Answered a request";
    default:
      return "Activity";
  }
}

export function TrustScreen({ onClose }: TrustScreenProps) {
  const { grants, automationGrants, criticalTools, activity, diary, parked, revoke } = useTrustData();

  return (
    <div className="fl-trust" role="dialog" aria-modal="true" aria-label="Trust">
      <div className="fl-trust-head">
        <div className="fl-trust-title">Vendo acts with your account. Here&apos;s where you stand.</div>
        <button type="button" className="fl-trust-close" aria-label="Close" onClick={onClose}>×</button>
      </div>

      <section className="fl-trust-section">
        <h3 className="fl-trust-section-head">Handled without asking</h3>
        {grants.length === 0 && <div className="fl-trust-empty">Nothing yet — everything still asks.</div>}
        {grants.map((g) => (
          <div key={g.id} className="fl-trust-row">
            <div className="fl-trust-row-main">
              <div className="fl-trust-row-title">{toolAction(g.tool).request} · {g.scopePreview}</div>
              <div className="fl-trust-row-meta">since {relativeTimeLabel(Date.parse(g.since))}</div>
            </div>
            {g.id && (
              <button type="button" className="fl-btn" onClick={() => revoke(g.id!)}>Ask me again</button>
            )}
          </div>
        ))}
      </section>

      <section className="fl-trust-section">
        <h3 className="fl-trust-section-head">Automations</h3>
        {automationGrants.length === 0 && <div className="fl-trust-empty">No automations running unattended yet.</div>}
        {automationGrants.map((g, i) => (
          <div key={`${g.automationName}-${g.tool}-${i}`} className="fl-trust-row">
            <div className="fl-trust-row-main">
              <div className="fl-trust-row-title">{g.automationName} — {toolAction(g.tool).request}</div>
              <div className="fl-trust-row-meta">runs as agreed</div>
            </div>
          </div>
        ))}
      </section>

      <section className="fl-trust-section">
        <h3 className="fl-trust-section-head">Always needs you</h3>
        <div className="fl-trust-critical">
          {criticalTools.length === 0
            ? "Nothing critical registered."
            : criticalTools.map((t) => toolAction(t.name).request).join(" · ")}
        </div>
      </section>

      {parked.count > 0 && (
        <section className="fl-trust-section">
          <h3 className="fl-trust-section-head">Waiting on you ({parked.count})</h3>
          <WaitingList actions={parked.actions} onApprove={parked.approve} onDecline={parked.decline} />
        </section>
      )}

      <section className="fl-trust-section">
        <h3 className="fl-trust-section-head">Activity — {diary.total} actions this week</h3>
        <div className="fl-trust-diary">
          This week I handled {diary.total} thing{diary.total === 1 ? "" : "s"} — {diary.reads} reads,{" "}
          {diary.approved} action{diary.approved === 1 ? "" : "s"} you approved, {diary.automationRuns} ran in
          automations. Money moves: {diary.moneyMoves}.
        </div>
        <div className="fl-trust-activity">
          {activity.slice(0, 20).map((row, i) => (
            <div key={i} className="fl-trust-activity-row">
              <span className="fl-trust-activity-time">{relativeTimeLabel(Date.parse(row.at))}</span>
              <span>{auditLine(row)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: CSS** — add to `styles.css`:

```css
/* ---------- Trust screen (ENG-193 §3 Moment 12) ---------- */
.fl-trust { display: flex; flex-direction: column; gap: 16px; padding: 16px; overflow-y: auto;
  background: var(--flowlet-bg); color: var(--flowlet-fg); font-family: var(--flowlet-font); }
.fl-trust-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.fl-trust-title { font-size: 14px; font-weight: 600; line-height: 1.4; }
.fl-trust-close { border: none; background: transparent; font-size: 20px; line-height: 1; cursor: pointer;
  color: var(--flowlet-fg-muted); }
.fl-trust-section { display: flex; flex-direction: column; gap: 8px; }
.fl-trust-section-head { font: 600 11px/1 var(--flowlet-font); letter-spacing: .04em; text-transform: uppercase;
  color: var(--flowlet-fg-muted); margin: 0; }
.fl-trust-empty { font-size: 12.5px; color: var(--flowlet-fg-muted); }
.fl-trust-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
  padding: 8px 0; border-top: 1px solid var(--flowlet-border); }
.fl-trust-row:first-of-type { border-top: none; }
.fl-trust-row-title { font: 600 13px/1.3 var(--flowlet-font); }
.fl-trust-row-meta { margin-top: 2px; font-size: 11px; color: var(--flowlet-fg-muted); }
.fl-trust-critical { font-size: 12.5px; color: var(--flowlet-fg-muted); }
.fl-trust-diary { font-size: 13px; line-height: 1.5; padding: 10px 12px; border-radius: 10px;
  background: var(--flowlet-accent-soft); }
.fl-trust-activity { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; }
.fl-trust-activity-row { display: flex; gap: 8px; font-size: 12px; color: var(--flowlet-fg-muted); }
.fl-trust-activity-time { flex-shrink: 0; width: 48px; }
```

- [ ] **Step 5: Run — PASS.** Export from `packages/flowlet-shell/src/index.ts`. `pnpm typecheck` — PASS. Commit — `feat(shell): TrustScreen — five sections + weekly diary (ENG-193 §3 Moment 12)`

---

### Task 14: Mount — accounting demo shield button + client seam wiring

**Files:**
- Create: `apps/demo-accounting/src/components/flowlet/trust.ts` (client fetchers, mirrors `parked-actions.ts`/`consent.ts`)
- Modify: `apps/demo-accounting/src/components/flowlet/FlowletRoot.tsx`
- Modify: `apps/demo-accounting/src/app/assistant/page.tsx`
- Test: `apps/demo-accounting/src/components/flowlet/trust.test.ts` (if a test convention exists for this app's client seam files — otherwise this is exercised by Task 16's browser pass)

- [ ] **Step 1: `trust.ts`** — client fetchers, mirroring `parked-actions.ts`'s style exactly:

```ts
import type { TrustAuditRow, TrustGrantRow } from "@flowlet/shell";

async function json<T>(res: Response, fallback: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error((body as { error?: string }).error ?? fallback);
  return body;
}

export async function listGrants(): Promise<TrustGrantRow[]> {
  const res = await fetch("/api/flowlet/grants");
  const body = await json<{ grants?: TrustGrantRow[] }>(res, `failed to list grants (${res.status})`);
  return body.grants ?? [];
}

export async function revokeGrant(id: string): Promise<void> {
  const res = await fetch("/api/flowlet/grants/revoke", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }),
  });
  await json(res, `failed to revoke grant (${res.status})`);
}

export async function queryAudit(opts: { sinceMs: number }): Promise<TrustAuditRow[]> {
  const res = await fetch(`/api/flowlet/audit?sinceMs=${opts.sinceMs}`);
  const body = await json<{ events?: TrustAuditRow[] }>(res, `failed to query audit (${res.status})`);
  return body.events ?? [];
}

export async function listCriticalTools(): Promise<{ name: string }[]> {
  const res = await fetch("/api/flowlet/critical-tools");
  const body = await json<{ tools?: { name: string }[] }>(res, `failed to list critical tools (${res.status})`);
  return body.tools ?? [];
}

export async function resolveFadeProposal(proposalId: string, accept: boolean): Promise<void> {
  const res = await fetch("/api/flowlet/fade-proposal", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposalId, accept }),
  });
  await json(res, `failed to resolve fade proposal (${res.status})`);
}
```

- [ ] **Step 2: Wire into `FlowletRoot.tsx`** — import the five functions and add `trust={{ listGrants, revokeGrant, queryAudit, listCriticalTools, resolveFadeProposal }}` to the `<FlowletShellProvider>` props, beside `parkedActions`.

- [ ] **Step 3: `assistant/page.tsx`** — add a `trustOpen` state and a quiet shield button beside the tab strip (the existing chrome the `WaitingList` already sits above):

```tsx
import { TrustScreen } from "@flowlet/shell"
// ...
function PageSurface() {
  // ... existing state
  const [trustOpen, setTrustOpen] = useState(false)
  // ...
  return (
    <div className="fl-page">
      {parked.count > 0 && (
        <WaitingList actions={parked.actions} onApprove={parked.approve} onDecline={parked.decline} />
      )}
      <div className="fl-tabbar" role="tablist">
        {/* ...existing Chat/saved tabs/"+" button... */}
        <button
          type="button"
          className="fl-tab fl-tab-trust"
          aria-label="Trust — what Vendo can do"
          onClick={() => setTrustOpen(true)}
        >
          🛡
        </button>
      </div>
      {/* ...existing fl-page-body... */}
      {trustOpen && (
        <div className="fl-trust-overlay" role="presentation" onClick={() => setTrustOpen(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <TrustScreen onClose={() => setTrustOpen(false)} />
          </div>
        </div>
      )}
      {/* ...existing toast... */}
    </div>
  )
}
```

Add a minimal `.fl-trust-overlay` rule to this app's own stylesheet (or `styles.css` if the shell owns overlay chrome elsewhere — check `FlowletOverlay.tsx`'s existing CSS for the established overlay-panel pattern and reuse its z-index/backdrop convention rather than inventing a new one):

```css
.fl-trust-overlay { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.28);
  display: flex; justify-content: flex-end; }
.fl-trust-overlay > div { width: min(420px, 92vw); height: 100%; background: var(--flowlet-bg);
  box-shadow: -8px 0 24px rgba(0,0,0,.12); }
```

- [ ] **Step 4: Run `pnpm typecheck` + `pnpm --filter demo-accounting build`. Commit** — `feat(demo-accounting): mount the Trust screen behind a shield button (ENG-193 §3 Moment 12)`

---

### Task 15: Permanent invariant tests (ENG-193 §7)

**Files:**
- Modify: `packages/flowlet-runtime/src/policy/invariants.test.ts` (append; do not touch existing cases)

- [ ] **Step 1: Add invariant cases**, each a `describe("ENG-193 §7 — fades", ...)` block:

```ts
describe("ENG-193 §7 — fade invariants (item 5)", () => {
  it("INVARIANT: fade is never offered for a critical tool", async () => {
    // handleConsent with a fadeTracker + a destructiveHint:true descriptor,
    // 3+ "yes" decisions on the same shape -> fadeEligible stays undefined
    // on every response (already covered functionally in consent.test.ts;
    // re-asserted here because it's a permanent §7 contract, not a feature test).
  });

  it("INVARIANT: fade is never offered for an unverified tool", async () => {
    // a descriptor with NO informative hints (isUnverified === true) -> same.
  });

  it("INVARIANT: accept mints a grant matching ONLY the derived shape (never tool-wide unless the shape itself was tool-wide)", async () => {
    // handleFadeProposal on a constrained-shape offer -> grant.scope.kind === "constrained"
    // with exactly ONE constraint matching the shape; a tool-wide-shape offer -> {kind:"tool"}.
  });

  it("INVARIANT: server re-derivation rejects a forged accept for an ineligible/unknown proposalId", async () => {
    // handleFadeProposal({proposalId: "forged", accept: true}) against a tracker that never
    // offered it -> ok:false, no grant created.
  });

  it("INVARIANT: revoke takes effect on the very next call (no caching)", async () => {
    // grantPolicy + a live GrantStore: mint a grant, confirm suppression, revoke it via
    // grantManager.revoke, confirm the NEXT evaluate() no longer suppresses (grant-policy.ts's
    // existing live store.findForTool lookup already guarantees this — this test just PINS it
    // as a permanent §7 contract so a future caching layer can't quietly break it).
  });
});
```

- [ ] **Step 2: Run — PASS (all invariants hold with Tasks 1–9's code). Any failure here is a Task 1–9 bug: fix the implementation, never the invariant.**

- [ ] **Step 3: Full gate: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` at repo root — all PASS.**

- [ ] **Step 4: Commit** — `test(runtime): ENG-193 §7 permanent fade invariant suite (item 5)`

---

### Task 16: Browser verification (real browser, screenshots required)

Per project standing rules, this is not optional for a UI-affecting change. Use `pnpm demo:accounting` (the Cadence app) with `FLOWLET_JUDGE_MODEL` unset (judge off, deterministic) so the fade counter is driven purely by grant/consent decisions.

- [ ] **Step 1:** Start the demo (`pnpm demo:accounting`), open the Assistant tab. Ask the agent to do the same act-tier, same-shape thing three times in a row (e.g., three separate "email [client] a reminder" requests to three different `@`-same-domain clients, or three individual approvals of the SAME batch-eligible tool if that's the faster path) so each produces its own `GMAIL_SEND_EMAIL` approval card, and approve all three.
  - Screenshot after the 3rd approval, showing the `FadeProposalCard` rendered inline. Save to `docs/superpowers/plans/assets/eng193-item5/01-fade-proposal.png`.
- [ ] **Step 2:** Click **"Sounds good."** Screenshot the card's disappearance / the next turn. Save to `.../02-fade-accepted.png`.
- [ ] **Step 3:** Trigger a 4th identical-shape request. It must execute WITHOUT an approval card (receipt only). Screenshot the receipt. Save to `.../03-fourth-auto.png`.
- [ ] **Step 4:** Click the new shield button. Screenshot the open `TrustScreen` showing the new grant under "Handled without asking" with its scope preview. Save to `.../04-trust-screen.png`.
- [ ] **Step 5:** Click **"Ask me again"** on that grant row. Screenshot the row disappearing / a toast if one exists. Save to `.../05-revoked.png`.
- [ ] **Step 6:** Trigger a 5th identical-shape request — it must prompt again (the revoke took effect). Screenshot the approval card. Save to `.../06-fifth-reprompts.png`.
- [ ] **Step 7:** Reopen the Trust screen, scroll to Activity. Screenshot the diary line with real counts. Save to `.../07-diary.png`.
- [ ] **Step 8 (critical-tier control):** Repeat the same-shape-3x approval flow against `set_document_status` (the demo's `x-flowlet-dangerous`/`destructiveHint` fixture, per item 2's own OpenAPI deviation) and confirm NO fade proposal ever appears, no matter how many times it's approved. Screenshot the 3rd+ approval showing the ceremony card still asking. Save to `.../08-critical-never-fades.png`.
- [ ] **Step 9:** Attach all screenshots to the PR description with one-line captions. Do not merge — per project rules, Yousef merges.

---

## Self-review checklist (run after all tasks)

- Spec §4.4 fade eligibility/proposal ✔ (Tasks 1–5) · server-side re-derivation, never trusts the client ✔ (Task 5, invariant in Task 15) · §3 Moment 12 Trust screen (5 sections + diary) ✔ (Tasks 8–9, 12–14) · §3 Moment 10 diary ✔ (Task 12) · §6.2 audit completeness the diary depends on ✔ (Task 6) · §7 invariants (never-critical, never-unverified, shape-only grant, forged-accept rejection, live-revoke) ✔ (Task 15).
- Every new server route is principal-scoped (guard first, `Principal` derived from the resolved `FlowletPrincipal`, never trusting a client-supplied id) — verify Task 8/9's routes all call `resolvePrincipal`/`demoPrincipalAllowed` before touching the store.
- `FadeTracker` and the Trust endpoints are additive optional seams throughout (absent → graceful no-op), matching `parkedActions`'s established precedent — no existing caller's behavior changes when they're omitted.
- NOT in this plan (later items, by design): steering/compiled rules (item 6), envelopes/act-then-undo/step-up (v2 track).
- Confirm the diary's firing-granularity choice (deviation #5) and the demo's fade-state-survives-reset choice (Task 9, Step 1) are both flagged for Yousef explicitly in the PR description, since both are judgment calls a plan alone can't fully close.
