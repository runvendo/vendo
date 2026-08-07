import { describe, expect, it } from "vitest";
import {
  VENDO_CAPABILITY_MISS_FORMAT,
  capabilityMissEventSchema,
  type CapabilityMissEvent,
} from "./index.js";

const base = {
  format: "vendo/capability-miss@1" as const,
  id: "mis_01",
  at: "2026-07-14T20:00:00.000Z",
  hostId: "host_maple",
  appId: "app_bank",
  sessionId: "session_01",
  threadId: "thr_01",
  intent: "Export my transactions to CSV",
  surface: {
    format: "vendo/tools@1" as const,
    hash: `sha256:${"a".repeat(64)}`,
  },
};

describe("vendo/capability-miss@1", () => {
  it("exports the format constant and parses all three closed trigger variants", () => {
    expect(VENDO_CAPABILITY_MISS_FORMAT).toBe("vendo/capability-miss@1");
    const events: CapabilityMissEvent[] = [
      {
        ...base,
        trigger: { kind: "no-matching-tool", toolsConsidered: ["host_transactions_list"] },
      },
      {
        ...base,
        id: "mis_02",
        trigger: {
          kind: "repeated-tool-failure",
          toolsConsidered: ["host_transactions_export"],
          attempts: [
            {
              tool: "host_transactions_export",
              attempt: 1,
              failure: { code: "timeout", message: "Export timed out." },
            },
            {
              tool: "host_transactions_export",
              attempt: 2,
              failure: { code: "timeout", message: "Export timed out again." },
            },
          ],
        },
      },
      {
        ...base,
        id: "mis_03",
        trigger: {
          kind: "agent-give-up",
          toolsConsidered: ["host_transactions_export"],
          toolsAttempted: ["host_transactions_export"],
        },
      },
    ];

    for (const event of events) expect(capabilityMissEventSchema.parse(event)).toEqual(event);
  });

  it("rejects malformed ids, surface hashes, trigger kinds, and short repeated-failure histories", () => {
    expect(capabilityMissEventSchema.safeParse({
      ...base,
      id: "event_01",
      trigger: { kind: "no-matching-tool", toolsConsidered: [] },
    }).success).toBe(false);
    expect(capabilityMissEventSchema.safeParse({
      ...base,
      surface: { format: "vendo/tools@1", hash: "sha256:not-a-digest" },
      trigger: { kind: "no-matching-tool", toolsConsidered: [] },
    }).success).toBe(false);
    expect(capabilityMissEventSchema.safeParse({
      ...base,
      trigger: { kind: "unknown", toolsConsidered: [] },
    }).success).toBe(false);
    expect(capabilityMissEventSchema.safeParse({
      ...base,
      trigger: {
        kind: "repeated-tool-failure",
        toolsConsidered: ["host_transactions_export"],
        attempts: [{
          tool: "host_transactions_export",
          attempt: 1,
          failure: { message: "Only one failure" },
        }],
      },
    }).success).toBe(false);
  });
});
