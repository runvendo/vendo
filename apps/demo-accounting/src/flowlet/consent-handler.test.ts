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

  it("404s when no pending approval part exists for the toolCallId", async () => {
    const res = await handleDemoConsent(req({
      id: "test-thread-missing", toolCallId: "call-missing", toolName: "GMAIL_SEND_EMAIL",
      response: { id: "call-missing", decision: "yes" },
    }));
    expect(res.status).toBe(404);
  });
});
