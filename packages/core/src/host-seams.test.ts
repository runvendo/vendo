import { describe, expect, it } from "vitest";
import { agentRunReportSchema, authMaterialSchema } from "./host-seams.js";

/** 01-core §13 — the host-owned seams (ActAs auth material, AgentRunner report). */
describe("authMaterialSchema", () => {
  it("accepts a headers bag and preserves unknown keys", () => {
    expect(authMaterialSchema.safeParse({ headers: {} }).success).toBe(true);
    expect(
      authMaterialSchema.parse({ headers: { authorization: "Bearer x" }, note: "extra" }),
    ).toMatchObject({ note: "extra" });
  });

  it("rejects a missing or non-string-valued headers bag", () => {
    expect(authMaterialSchema.safeParse({}).success).toBe(false);
    expect(authMaterialSchema.safeParse({ headers: { authorization: 1 } }).success).toBe(false);
  });
});

describe("agentRunReportSchema", () => {
  const call = { id: "call_1", tool: "host_x", args: { a: "1" } };

  it("accepts a report with each valid status and tool-call outcome", () => {
    expect(agentRunReportSchema.safeParse({ status: "ok", summary: "done", toolCalls: [] }).success).toBe(true);
    expect(
      agentRunReportSchema.safeParse({
        status: "stopped",
        summary: "cancelled",
        toolCalls: [{ call, outcome: "blocked" }],
      }).success,
    ).toBe(true);
  });

  it("rejects an out-of-enum status or outcome", () => {
    expect(agentRunReportSchema.safeParse({ status: "running", summary: "s", toolCalls: [] }).success).toBe(false);
    expect(
      agentRunReportSchema.safeParse({ status: "ok", summary: "s", toolCalls: [{ call, outcome: "queued" }] }).success,
    ).toBe(false);
  });
});
