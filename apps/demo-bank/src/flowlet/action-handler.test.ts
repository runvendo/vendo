import { describe, it, expect } from "vitest";
import { handleStageAction } from "./action-handler";

const post = (body: unknown) =>
  new Request("http://localhost/api/flowlet/action", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost" },
    body: JSON.stringify(body),
  });

describe("handleStageAction", () => {
  it("executes an allowed action and returns its result", async () => {
    const res = await handleStageAction(post({ action: "get_transactions", payload: {} }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.decision).toBe("allow");
    expect(Array.isArray(json.result)).toBe(true);
  });

  it("returns needsApproval (and does NOT execute) for approve-decided actions", async () => {
    const res = await handleStageAction(post({ action: "SLACK_SEND_MESSAGE", payload: {} }));
    const json = await res.json();
    expect(json.needsApproval).toBe(true);
    expect(json.result).toBeUndefined();
  });

  it("rejects unknown action names with 404", async () => {
    const res = await handleStageAction(post({ action: "definitely_not_a_tool", payload: {}, approved: true }));
    expect(res.status).toBe(404);
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await handleStageAction(post({ nope: true }));
    expect(res.status).toBe(400);
  });
});
