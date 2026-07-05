import { describe, expect, it } from "vitest";
import { createConsentLedger, handleConsent } from "./consent.js";
import { createInMemoryGrantStore } from "./grant-store.js";
import { InMemoryAuditLog, InMemoryThreadStore } from "./embedded/in-memory-store.js";
import { createFadeTracker } from "./fade-tracker.js";
import type { FadeTracker } from "./fade-tracker.js";
import { grantPolicy } from "./policy/grant-policy.js";
import type { ToolDescriptor } from "./descriptor.js";
import type { VendoUIMessage } from "@vendoai/core";

const scope = { tenantId: "t", subject: "u" };
const now = () => "2026-07-04T00:00:00Z";

function threadWith(part: Record<string, unknown>): VendoUIMessage[] {
  return [
    { id: "m1", role: "assistant", parts: [
      { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "call-1", state: "approval-requested",
        input: { to: "acme@example.com" }, approval: { id: "ap-1" }, ...part },
    ] } as unknown as VendoUIMessage,
  ];
}

function deps(threadMessages: VendoUIMessage[]) {
  const grants = createInMemoryGrantStore({ now });
  const audit = new InMemoryAuditLog();
  const threads = new InMemoryThreadStore(now);
  return {
    grants, audit, threads,
    resolveDescriptor: (name: string): ToolDescriptor | undefined =>
      name === "GMAIL_SEND_EMAIL"
        ? // ENG-193 §4.4 (Task 4 deviation): explicit readOnlyHint: false marks
          // this descriptor VERIFIED — an all-{} annotations object is
          // "unverified" per policy/tier.ts's `isUnverified` (landed item 3),
          // which would otherwise make this fixture ineligible for fade
          // tracking despite being the plan's own act-tier fade fixture.
          { name, source: "composio", annotations: { readOnlyHint: false }, hasExecute: true, kind: "function" }
        : name === "transfer_money"
          ? { name, source: "caller", annotations: { destructiveHint: true }, hasExecute: true, kind: "function" }
          : undefined,
    async getMessages() { return threadMessages; },
    // Instant in every test by default — real retry TIMING isn't under test
    // here (item F's regression below only cares that a later lookup sees
    // freshly-arrived messages), and a real 250ms wait per retry would slow
    // every 404 case in this suite for nothing.
    sleep: async () => {},
  };
}

function depsWithFade(threadMessages: VendoUIMessage[]) {
  return { ...deps(threadMessages), fadeTracker: createFadeTracker() };
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

  it("400s when the tool name doesn't match the pending part's tool (and still audits the decision)", async () => {
    const d = deps(threadWith({}));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "some_other_tool",
      response: { id: "call-1", decision: "yes" },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(await d.audit.query(scope, { kinds: ["consent"] })).toHaveLength(1);
  });

  it("404s when no approval-requested part with that toolCallId exists (and still audits the decision)", async () => {
    const d = deps([]);
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-missing", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-missing", decision: "yes" },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(await d.audit.query(scope, { kinds: ["consent"] })).toHaveLength(1);
  });

  it("REGRESSION (ENG-193 PR #40 review — item F): a miss on the FIRST lookup retries and succeeds once the engine's onSettled write lands between attempts", async () => {
    // Simulates the documented onSettled fire-and-forget race: the first
    // lookup finds nothing (persistence hasn't landed yet), but the SECOND
    // lookup (the first retry) does — before this fix that first miss would
    // have 404'd outright.
    let calls = 0;
    const getMessages = async () => {
      calls += 1;
      return calls >= 2 ? threadWith({}) : [];
    };
    const sleepCalls: number[] = [];
    const d = {
      ...deps([]),
      getMessages,
      sleep: async (ms: number) => { sleepCalls.push(ms); },
    };
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes" },
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2); // one miss, one retry that hits
    expect(sleepCalls).toEqual([250]); // exactly one retry delay elapsed
  });

  it("REGRESSION (ENG-193 PR #40 review — item F): still 404s after exhausting BOTH retries (3 lookups total)", async () => {
    let calls = 0;
    const getMessages = async () => { calls += 1; return []; };
    const d = { ...deps([]), getMessages };
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-missing", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-missing", decision: "yes" },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(calls).toBe(3); // the initial lookup + 2 retries
  });

  it("400s a grant draft whose tool differs from the consented tool — grant.tool is bound server-side", async () => {
    const d = deps(threadWith({}));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes",
        grant: { tool: "transfer_money", scope: { kind: "tool" }, duration: "standing" } },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(await d.grants.findForTool(scope, "transfer_money")).toHaveLength(0);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(0);
    expect(await d.audit.query(scope, { kinds: ["consent"] })).toHaveLength(1);
  });

  it("404s an unknown tool (unresolvable descriptor) and still audits the decision", async () => {
    const d = deps(threadWith({ type: "tool-not_a_real_tool" }));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "not_a_real_tool",
      response: { id: "call-1", decision: "yes",
        grant: { tool: "not_a_real_tool", scope: { kind: "tool" }, duration: "standing" } },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(await d.audit.query(scope, { kinds: ["consent"] })).toHaveLength(1);
  });

  it("a plain 'yes' with no response.grant mints a session-scoped exact grant server-side (spec §4.3 — 'allow once')", async () => {
    const d = deps(threadWith({}));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes" },
    });
    expect(result.ok).toBe(true);
    const [grant] = await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL");
    expect(grant).toBeDefined();
    expect(grant?.scope.kind).toBe("exact");
    expect(grant?.duration).toBe("session");
    expect(grant?.contextKey).toBe("th-1");
    expect(grant?.source).toEqual({ kind: "chat" });
  });

  it("REVIEW FOLLOW-UP: a session/task-duration grant mints WITH a contextKey (= the request's threadId) — grantPolicy suppresses in the SAME thread, not a different one", async () => {
    const d = deps(threadWith({}));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes",
        grant: { tool: "GMAIL_SEND_EMAIL", scope: { kind: "tool" }, duration: "session" } },
    });
    expect(result.ok).toBe(true);
    const [grant] = await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL");
    expect(grant?.contextKey).toBe("th-1"); // dead-on-arrival before this fix (grant-match requires it)

    const descriptor = d.resolveDescriptor("GMAIL_SEND_EMAIL")!;
    const policy = grantPolicy({ evaluate: () => "approve" }, d.grants, {
      principalScope: () => scope,
      contextKey: (ctx) => ctx.threadId,
    });
    const baseCtx = { toolName: "GMAIL_SEND_EMAIL", input: {}, descriptor, principal: { userId: "u" } };
    expect(await policy.evaluate({ ...baseCtx, threadId: "th-1" })).toBe("allow");
    expect(await policy.evaluate({ ...baseCtx, threadId: "th-2" })).toBe("approve");
  });

  it("a STANDING grant mints WITHOUT a contextKey (unaffected by the session/task fix)", async () => {
    const d = deps(threadWith({}));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes",
        grant: { tool: "GMAIL_SEND_EMAIL", scope: { kind: "tool" }, duration: "standing" } },
    });
    expect(result.ok).toBe(true);
    const [grant] = await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL");
    expect(grant?.contextKey).toBeUndefined();
  });

  it("FINDING 5: a consent POST after the tool part already reached output-available still succeeds (200, grant minted) — existence + tool-name match is the only validation", async () => {
    const d = deps(threadWith({ state: "output-available", output: "sent", approval: { id: "ap-1", approved: true } }));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes",
        grant: { tool: "GMAIL_SEND_EMAIL", scope: { kind: "tool" }, duration: "standing" } },
    });
    expect(result.ok).toBe(true);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(1);
  });

  it("FINDING 5: also succeeds when the part settled to approval-responded (already answered elsewhere, approved)", async () => {
    const d = deps(threadWith({ state: "approval-responded", approval: { id: "ap-1", approved: true } }));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes",
        grant: { tool: "GMAIL_SEND_EMAIL", scope: { kind: "tool" }, duration: "standing" } },
    });
    expect(result.ok).toBe(true);
  });

  it("Greptile P1 (declined anchor): a DECLINED part (approval.approved === false) 409s an affirmative 'yes' — no grant of any kind, no fade yes", async () => {
    for (const state of ["output-denied", "approval-responded"]) {
      const tracker = createFadeTracker();
      let recordCalls = 0;
      const spyTracker: FadeTracker = {
        ...tracker,
        record: (...args: Parameters<FadeTracker["record"]>) => {
          recordCalls += 1;
          return tracker.record(...args);
        },
      };
      const d = {
        ...deps(threadWith({ state, approval: { id: "ap-1", approved: false } })),
        fadeTracker: spyTracker,
      };
      const result = await handleConsent(d, scope, {
        threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
        response: { id: "call-1", decision: "yes",
          grant: { tool: "GMAIL_SEND_EMAIL", scope: { kind: "tool" }, duration: "standing" } },
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(409);
      expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(0);
      expect(recordCalls).toBe(0);
    }
  });

  it("Greptile P1 (declined anchor): 'subset' is affirmative too — 409 over a decline; but a 'no' over a declined part still records fine (200)", async () => {
    const declined = threadWith({ state: "output-denied", approval: { id: "ap-1", approved: false } });
    const subsetResult = await handleConsent(deps(declined), scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "subset", subset: ["call-1"] },
    });
    expect(subsetResult.ok).toBe(false);
    expect(subsetResult.status).toBe(409);
    const noResult = await handleConsent(deps(declined), scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "no" },
    });
    expect(noResult.ok).toBe(true);
  });

  it("Greptile P1 (over-relaxation): an AUTO-ALLOWED part (terminal state, no `approval` metadata — never showed a card) 404s with an explicit grant draft, and mints NO grant", async () => {
    const d = deps(threadWith({ state: "output-available", output: "sent", approval: undefined }));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes",
        grant: { tool: "GMAIL_SEND_EMAIL", scope: { kind: "tool" }, duration: "standing" } },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(0);
  });

  it("Greptile P1 (over-relaxation): an AUTO-ALLOWED part also 404s a plain 'yes' — no implicit session-scoped mint either", async () => {
    const d = deps(threadWith({ state: "output-available", output: "sent", approval: undefined }));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes" },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(0);
  });

  it("FINDING 5: STILL 404s when the part is truly absent from the thread", async () => {
    const d = deps([]);
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-missing", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-missing", decision: "yes" },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
  });

  it("FINDING 5 knock-on: the success-only ledger still dedupes a replay after the part reached a terminal state — a duplicate POST never mints a second grant", async () => {
    const d = {
      ...deps(threadWith({ state: "output-available", output: "sent", approval: { id: "ap-1", approved: true } })),
      seen: createConsentLedger(),
    };
    const req = {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes" as const,
        grant: { tool: "GMAIL_SEND_EMAIL", scope: { kind: "tool" as const }, duration: "standing" as const } },
    };
    const first = await handleConsent(d, scope, req);
    const second = await handleConsent(d, scope, req);
    expect(second).toEqual(first);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(1);
  });

  it("FINDING 6: fadeTracker.record only fires on the success path — repeated bad POSTs (grant.tool mismatch, 400) record ZERO decisions", async () => {
    const tracker = createFadeTracker();
    let recordCalls = 0;
    const spyTracker: FadeTracker = {
      ...tracker,
      record: (...args: Parameters<FadeTracker["record"]>) => {
        recordCalls += 1;
        return tracker.record(...args);
      },
    };
    const d = { ...deps(threadWith({})), fadeTracker: spyTracker };
    const badReq = {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes" as const,
        // grant.tool mismatches the consented tool — 400s AFTER fadeTracker's
        // pre-fix call site, so a pre-fix run would already have recorded a
        // "yes" for this shape before the validation rejected the request.
        grant: { tool: "transfer_money", scope: { kind: "tool" as const }, duration: "standing" as const } },
    };
    const first = await handleConsent(d, scope, badReq);
    expect(first.ok).toBe(false);
    expect(first.status).toBe(400);
    const second = await handleConsent(d, scope, badReq);
    expect(second.ok).toBe(false);
    expect(second.status).toBe(400);

    expect(recordCalls).toBe(0);
  });

  it("FINDING 6: a grant.tool mismatch never inflates the fade eligibility count — 3 GENUINE yeses still earn the offer at exactly count 3", async () => {
    const d = depsWithFade(threadWith({}));
    const badReq = {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes" as const,
        grant: { tool: "transfer_money", scope: { kind: "tool" as const }, duration: "standing" as const } },
    };
    await handleConsent(d, scope, badReq);
    await handleConsent(d, scope, badReq);

    for (let i = 0; i < 2; i++) {
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
    // Exactly 3 — NOT 5, which is what it would be if the 2 bad POSTs above
    // had also recorded a "yes" (pre-fix behavior).
    expect(result.ok && result.fadeEligible?.count).toBe(3);
  });

  it("FINDING 6: a 'no' decision (no grant involved, nothing CAN 400 after it) still records exactly as before", async () => {
    const d = depsWithFade(threadWith({}));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "no" },
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.fadeEligible).toBeUndefined();
  });
});

describe("handleConsent — idempotency (review follow-up)", () => {
  it("a duplicate POST for the SAME toolCallId returns the identical result and never mints a second grant or a second audit event", async () => {
    const d = { ...deps(threadWith({})), seen: createConsentLedger() };
    const req = {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes" as const,
        grant: { tool: "GMAIL_SEND_EMAIL", scope: { kind: "tool" as const }, duration: "standing" as const } },
    };
    const first = await handleConsent(d, scope, req);
    const second = await handleConsent(d, scope, req);
    expect(second).toEqual(first);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(1);
    expect(await d.audit.query(scope, { kinds: ["consent"] })).toHaveLength(1);
  });

  it("REVIEW FOLLOW-UP: a transient 404 (approval part not found, e.g. the onSettled persistence race) is NEVER cached — a later retry for the SAME toolCallId succeeds once the part persists", async () => {
    let persisted = false;
    const getMessages = async () => (persisted ? threadWith({}) : []);
    const d = { ...deps([]), getMessages, seen: createConsentLedger() };
    const req = {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes" as const },
    };

    const first = await handleConsent(d, scope, req);
    expect(first.ok).toBe(false);
    expect(first.ok === false && first.status).toBe(404);

    persisted = true; // the fire-and-forget onSettled write finally lands
    const second = await handleConsent(d, scope, req);
    expect(second.ok).toBe(true); // NOT the cached 404 — it re-evaluated and found the part
    expect(await d.audit.query(scope, { kinds: ["consent"] })).toHaveLength(2); // both attempts audited
  });

  it("a duplicate POST never double-records a fade decision — the 3rd DISTINCT yes, not the duplicate, is what earns the offer", async () => {
    const messages = [
      { id: "m1", role: "assistant", parts: [
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "call-1", state: "approval-requested", input: { to: "a@example.com" }, approval: { id: "ap-1" } },
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "call-2", state: "approval-requested", input: { to: "b@example.com" }, approval: { id: "ap-2" } },
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "call-3", state: "approval-requested", input: { to: "c@example.com" }, approval: { id: "ap-3" } },
      ] },
    ] as unknown as VendoUIMessage[];
    const d = { ...depsWithFade(messages), seen: createConsentLedger() };
    const post = (toolCallId: string) =>
      handleConsent(d, scope, {
        threadId: "th-1", toolCallId, toolName: "GMAIL_SEND_EMAIL",
        response: { id: toolCallId, decision: "yes" },
      });
    await post("call-1");
    await post("call-1"); // duplicate — must not count a second time
    await post("call-2"); // 2nd distinct yes
    const third = await post("call-3"); // 3rd distinct yes — earns the offer at exactly 3
    expect(third.ok).toBe(true);
    expect(third.ok && third.fadeEligible?.count).toBe(3);
    expect(await d.audit.query(scope, { kinds: ["consent"] })).toHaveLength(3); // not 4
  });
});

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
    // Review nit: the card renders its own ordinal from this count instead of
    // hardcoding "third" — carry the tracker's own in-window yes-count.
    expect(result.ok && result.fadeEligible?.count).toBe(3);
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

describe("handleConsent — plain 'yes' mints a session-scoped exact grant (Greptile P1, spec §4.3)", () => {
  function policyFor(d: ReturnType<typeof deps>) {
    return grantPolicy({ evaluate: () => "approve" }, d.grants, {
      principalScope: () => scope,
      contextKey: (ctx) => ctx.threadId,
    });
  }

  it("an identical follow-up call in the SAME thread is suppressed (allow) after a plain yes", async () => {
    const d = deps(threadWith({}));
    await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes" },
    });
    const descriptor = d.resolveDescriptor("GMAIL_SEND_EMAIL")!;
    const policy = policyFor(d);
    const input = { to: "acme@example.com" }; // byte-identical to threadWith's default part.input
    expect(
      await policy.evaluate({ toolName: "GMAIL_SEND_EMAIL", input, descriptor, principal: { userId: "u" }, threadId: "th-1" }),
    ).toBe("allow");
  });

  it("a different input still asks — the mint is exact, not tool-wide", async () => {
    const d = deps(threadWith({}));
    await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes" },
    });
    const descriptor = d.resolveDescriptor("GMAIL_SEND_EMAIL")!;
    const policy = policyFor(d);
    const differentInput = { to: "someone-else@example.com" };
    expect(
      await policy.evaluate({ toolName: "GMAIL_SEND_EMAIL", input: differentInput, descriptor, principal: { userId: "u" }, threadId: "th-1" }),
    ).toBe("approve");
  });

  it("a different thread still asks — the mint is session-scoped to the consenting thread", async () => {
    const d = deps(threadWith({}));
    await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes" },
    });
    const descriptor = d.resolveDescriptor("GMAIL_SEND_EMAIL")!;
    const policy = policyFor(d);
    const input = { to: "acme@example.com" };
    expect(
      await policy.evaluate({ toolName: "GMAIL_SEND_EMAIL", input, descriptor, principal: { userId: "u" }, threadId: "th-2" }),
    ).toBe("approve");
  });

  it("a critical tool's plain yes mints NO grant — 200 ok, findForTool stays empty", async () => {
    const d = deps(threadWith({ type: "tool-transfer_money", input: {} }));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "transfer_money",
      response: { id: "call-1", decision: "yes" },
    });
    expect(result.ok).toBe(true);
    expect(await d.grants.findForTool(scope, "transfer_money")).toHaveLength(0);
  });

  it("a replayed POST (idempotency ledger) mints exactly ONE grant, never two", async () => {
    const d = { ...deps(threadWith({})), seen: createConsentLedger() };
    const req = {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes" as const },
    };
    await handleConsent(d, scope, req);
    await handleConsent(d, scope, req);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(1);
  });

  it("an explicit client grant draft still takes precedence over the implicit mint", async () => {
    const d = deps(threadWith({}));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes",
        grant: { tool: "GMAIL_SEND_EMAIL", scope: { kind: "tool" }, duration: "standing" } },
    });
    expect(result.ok).toBe(true);
    const grants = await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL");
    expect(grants).toHaveLength(1); // not a second, implicit one alongside it
    expect(grants[0]?.scope.kind).toBe("tool"); // the EXPLICIT draft's scope, not an implicit exact one
    expect(grants[0]?.duration).toBe("standing");
  });

  it("REVIEW FOLLOW-UP: a batch 'subset' decision mints the SAME implicit session-scoped exact grant a plain 'yes' does — a byte-identical repeat of a subset-approved call is suppressed", async () => {
    const d = deps(threadWith({}));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "subset", subset: ["call-1", "call-2"] },
    });
    expect(result.ok).toBe(true);
    const [grant] = await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL");
    expect(grant).toBeDefined();
    expect(grant?.scope.kind).toBe("exact");
    expect(grant?.duration).toBe("session");
    expect(grant?.contextKey).toBe("th-1");

    const descriptor = d.resolveDescriptor("GMAIL_SEND_EMAIL")!;
    const policy = grantPolicy({ evaluate: () => "approve" }, d.grants, {
      principalScope: () => scope,
      contextKey: (ctx) => ctx.threadId,
    });
    const input = { to: "acme@example.com" }; // byte-identical to threadWith's default part.input
    expect(
      await policy.evaluate({ toolName: "GMAIL_SEND_EMAIL", input, descriptor, principal: { userId: "u" }, threadId: "th-1" }),
    ).toBe("allow");
  });

  it("REVIEW FOLLOW-UP: a critical tool's subset decision mints NO grant, same as a plain yes", async () => {
    const d = deps(threadWith({ type: "tool-transfer_money", input: {} }));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "transfer_money",
      response: { id: "call-1", decision: "subset", subset: ["call-1"] },
    });
    expect(result.ok).toBe(true);
    expect(await d.grants.findForTool(scope, "transfer_money")).toHaveLength(0);
  });

  it("an unverified tool's plain yes still mints (Yousef ruling: exact-scope session grants are fine for unverified tools)", async () => {
    const messages = [
      { id: "m1", role: "assistant", parts: [
        { type: "tool-mystery_tool", toolCallId: "call-1", state: "approval-requested", input: { x: 1 } },
      ] },
    ] as unknown as VendoUIMessage[];
    const d = {
      ...deps(messages),
      resolveDescriptor: (name: string): ToolDescriptor | undefined =>
        name === "mystery_tool"
          ? { name, source: "caller", annotations: {}, hasExecute: true, kind: "function" }
          : undefined,
    };
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "mystery_tool",
      response: { id: "call-1", decision: "yes" },
    });
    expect(result.ok).toBe(true);
    expect(await d.grants.findForTool(scope, "mystery_tool")).toHaveLength(1);
  });
});
