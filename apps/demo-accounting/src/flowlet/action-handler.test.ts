import { describe, it, expect, beforeEach } from "vitest";
import { handleStageAction } from "./action-handler";
import { __reseed } from "@/server/store";

const post = (body: unknown) =>
  new Request("http://localhost/api/flowlet/action", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost" },
    body: JSON.stringify(body),
  });

describe("handleStageAction", () => {
  beforeEach(() => {
    __reseed(new Date("2026-07-02T12:00:00-07:00"));
  });

  it("executes an allowed read and returns its result", async () => {
    const res = await handleStageAction(post({ action: "get_clients", payload: {} }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.decision).toBe("allow");
    expect(Array.isArray(json.result)).toBe(true);
    expect(json.result.length).toBe(12);
  });

  it("scopes get_client_documents to the requested client", async () => {
    const res = await handleStageAction(
      post({ action: "get_client_documents", payload: { clientId: "cl_rivera" } }),
    );
    const json = await res.json();
    expect(json.result.every((d: { clientId: string }) => d.clientId === "cl_rivera")).toBe(true);
  });

  it("returns needsApproval (and does NOT execute) for approve-decided actions", async () => {
    const res = await handleStageAction(post({ action: "GMAIL_SEND_EMAIL", payload: {} }));
    const json = await res.json();
    expect(json.needsApproval).toBe(true);
    expect(json.result).toBeUndefined();
  });

  it("rejects unknown action names with 404 even when 'approved'", async () => {
    const res = await handleStageAction(post({ action: "definitely_not_a_tool", payload: {}, approved: true }));
    expect(res.status).toBe(404);
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await handleStageAction(post({ nope: true }));
    expect(res.status).toBe(400);
  });
});
