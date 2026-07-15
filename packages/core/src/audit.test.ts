import { describe, expect, it } from "vitest";
import { auditEventSchema } from "./audit.js";

/** 01-core §7 — the append-only audit event. */
const base = {
  id: "aud_1",
  at: "2026-07-12T12:00:00.000Z",
  kind: "tool-call" as const,
  principal: { kind: "user" as const, subject: "user_a" },
  venue: "chat" as const,
  presence: "present" as const,
};

describe("auditEventSchema", () => {
  it("accepts a minimal tool-call event and a fully-populated one", () => {
    expect(auditEventSchema.safeParse(base).success).toBe(true);
    expect(
      auditEventSchema.safeParse({
        ...base,
        kind: "policy-decision",
        appId: "app_1",
        tool: "host_x",
        inputPreview: "list 10",
        outcome: "blocked",
        decidedBy: "rule",
        detail: { reason: "no grant" },
      }).success,
    ).toBe(true);
  });

  it("requires the aud_ id prefix", () => {
    expect(auditEventSchema.safeParse({ ...base, id: "1" }).success).toBe(false);
    expect(auditEventSchema.safeParse({ ...base, id: "evt_1" }).success).toBe(false);
    expect(auditEventSchema.safeParse({ ...base, id: "aud_" }).success).toBe(false);
  });

  it("constrains kind, venue, presence, outcome and decidedBy to their enums", () => {
    expect(auditEventSchema.safeParse({ ...base, kind: "login" }).success).toBe(false);
    expect(auditEventSchema.safeParse({ ...base, venue: "cli" }).success).toBe(false);
    expect(auditEventSchema.safeParse({ ...base, presence: "idle" }).success).toBe(false);
    expect(auditEventSchema.safeParse({ ...base, outcome: "queued" }).success).toBe(false);
    expect(auditEventSchema.safeParse({ ...base, decidedBy: "human" }).success).toBe(false);
    // Valid boundary values from the enums.
    expect(auditEventSchema.safeParse({ ...base, kind: "door-auth", venue: "mcp" }).success).toBe(true);
    expect(auditEventSchema.safeParse({ ...base, decidedBy: "scanner", outcome: "pending-approval" }).success).toBe(true);
  });
});
