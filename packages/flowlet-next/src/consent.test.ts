import { describe, expect, it } from "vitest";
import { handleConsentRoute } from "./consent";
import {
  createFadeTracker,
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

  it("threads fadeEligible from handleConsent into the route's JSON body (ENG-193 §4.4)", async () => {
    const deps = {
      ...makeDeps(),
      // Explicit readOnlyHint: false marks this descriptor VERIFIED — an
      // all-{} annotations object is "unverified" per policy/tier.ts's
      // `isUnverified`, which would make it fade-ineligible (same fixture
      // rationale as packages/flowlet-runtime/src/consent.test.ts).
      resolveDescriptor: (name: string) =>
        name === "GMAIL_SEND_EMAIL"
          ? { name, source: "composio" as const, annotations: { readOnlyHint: false }, hasExecute: true, kind: "function" as const }
          : undefined,
      fadeTracker: createFadeTracker(),
    };
    const threadId = await deps.threadIndex.resolve(scope, "chat-2");
    for (const to of ["a@b.com", "b@b.com", "c@b.com"]) {
      await deps.threads.appendMessages(scope, threadId, [
        { id: `m-${to}`, role: "assistant", parts: [
          { type: "tool-GMAIL_SEND_EMAIL", toolCallId: `call-${to}`, state: "approval-requested",
            input: { to }, approval: { id: `ap-${to}` } },
        ] } as never,
      ]);
      const res = await handleConsentRoute(req({
        id: "chat-2", toolCallId: `call-${to}`, toolName: "GMAIL_SEND_EMAIL",
        response: { id: `call-${to}`, decision: "yes" },
      }), deps);
      expect(res.status).toBe(200);
    }
    await deps.threads.appendMessages(scope, threadId, [
      { id: "m-final", role: "assistant", parts: [
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "call-final", state: "approval-requested",
          input: { to: "d@b.com" }, approval: { id: "ap-final" } },
      ] } as never,
    ]);
    const res = await handleConsentRoute(req({
      id: "chat-2", toolCallId: "call-final", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-final", decision: "yes" },
    }), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; fadeEligible?: { proposalId: string; count?: number } };
    expect(body.ok).toBe(true);
    expect(body.fadeEligible?.proposalId).toBeTruthy();
    // Review nit: the route passes the tracker's own yes-count through
    // verbatim — the card renders its ordinal from this, not a hardcoded
    // "third". Loop records 3 yeses (a/b/c) before this 4th (d) one.
    expect(body.fadeEligible?.count).toBe(4);
  });
});
