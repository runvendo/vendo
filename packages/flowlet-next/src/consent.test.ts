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
