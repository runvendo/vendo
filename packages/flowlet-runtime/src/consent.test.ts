import { describe, expect, it } from "vitest";
import { handleConsent } from "./consent";
import { createInMemoryGrantStore } from "./grant-store";
import { InMemoryAuditLog, InMemoryThreadStore } from "./embedded/in-memory-store";
import { createFadeTracker } from "./fade-tracker";
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
