import { describe, it, expect } from "vitest";
import { SCHEMA_VERSION, type ApprovalRequest } from "./protocol";

describe("protocol", () => {
  it("exposes a schema version", () => {
    expect(typeof SCHEMA_VERSION).toBe("number");
  });

  it("types an approval request with a correlation id", () => {
    const req: ApprovalRequest = { approvalId: "a1", toolCallId: "t1", prompt: "ok?", input: {} };
    expect(req.approvalId).toBe("a1");
  });
});
