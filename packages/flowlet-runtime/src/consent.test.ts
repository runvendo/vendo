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
