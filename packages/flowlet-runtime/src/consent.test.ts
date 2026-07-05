import { describe, expect, it } from "vitest";
import { createConsentLedger, handleConsent } from "./consent";
import { createInMemoryGrantStore } from "./grant-store";
import { InMemoryAuditLog, InMemoryThreadStore } from "./embedded/in-memory-store";
import { createFadeTracker } from "./fade-tracker";
import { grantPolicy } from "./policy/grant-policy";
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

function depsWithFade(threadMessages: FlowletUIMessage[]) {
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

  it("no grant is created without a response.grant even on 'yes' — approving once doesn't imply remembering", async () => {
    const d = deps(threadWith({}));
    const result = await handleConsent(d, scope, {
      threadId: "th-1", toolCallId: "call-1", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-1", decision: "yes" },
    });
    expect(result.ok).toBe(true);
    expect(await d.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(0);
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
    ] as unknown as FlowletUIMessage[];
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
