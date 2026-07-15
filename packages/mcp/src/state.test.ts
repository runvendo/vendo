import { describe, expect, it } from "vitest";
import {
  InMemoryMcpDoorState,
  type McpStateSession,
} from "./state.js";

describe("InMemoryMcpDoorState", () => {
  it("shares idle expiry between a session and its approval replay scope", () => {
    const state = new InMemoryMcpDoorState();
    const session = testSession("mcps_1", "replay_1", "user_1");
    state.setSession({
      sessionId: "mcps_1",
      subject: "user_1",
      clientId: "mcpc_1",
      grantFamilyId: "mcgf_1",
      session,
      expiresAt: 10,
    });
    state.setReplay("replay_1", "fingerprint", "mctc_1", {
      subject: "user_1",
      expiresAt: 10,
      capacity: 256,
    });

    state.touchSession("mcps_1", 20);
    expect(state.sweepExpiredSessions(15)).toEqual([]);
    expect(state.getReplay("replay_1", "fingerprint", 15)).toBe("mctc_1");

    expect(state.sweepExpiredSessions(20)).toEqual([session]);
    expect(state.getReplay("replay_1", "fingerprint", 20)).toBeNull();
  });

  it("purges stateless replay records by authenticated subject", () => {
    const state = new InMemoryMcpDoorState();
    state.setReplay("durable_1", "fingerprint", "mctc_1", {
      subject: "user_1",
      expiresAt: 20,
      capacity: 256,
    });

    expect(state.deleteSessionsBySubject("user_1")).toEqual([]);
    expect(state.getReplay("durable_1", "fingerprint", 10)).toBeNull();
  });

  it("selectively removes live sessions by client or grant family", () => {
    const state = new InMemoryMcpDoorState();
    const familyA = testSession("mcps_a", "replay_a", "user_1", "mcpc_a");
    const familyB = testSession("mcps_b", "replay_b", "user_1", "mcpc_a");
    const otherClient = testSession("mcps_c", "replay_c", "user_1", "mcpc_b");
    state.setSession({
      sessionId: "mcps_a",
      subject: "user_1",
      clientId: "mcpc_a",
      grantFamilyId: "mcgf_a",
      session: familyA,
      expiresAt: 20,
    });
    state.setSession({
      sessionId: "mcps_b",
      subject: "user_1",
      clientId: "mcpc_a",
      grantFamilyId: "mcgf_b",
      session: familyB,
      expiresAt: 20,
    });
    state.setSession({
      sessionId: "mcps_c",
      subject: "user_1",
      clientId: "mcpc_b",
      grantFamilyId: "mcgf_c",
      session: otherClient,
      expiresAt: 20,
    });

    expect(state.deleteSessionsByGrantFamily("mcgf_a")).toEqual([familyA]);
    expect(state.deleteSessionsBySubjectClient("user_1", "mcpc_a")).toEqual([familyB]);
    expect(state.getSession("mcps_c")).toBe(otherClient);
  });

  it("expires replay records and enforces the per-scope capacity", () => {
    const state = new InMemoryMcpDoorState();
    const options = { subject: "user_1", expiresAt: 20, capacity: 2 };
    state.setReplay("scope", "first", "mctc_1", options);
    state.setReplay("scope", "second", "mctc_2", options);
    state.setReplay("scope", "third", "mctc_3", options);

    expect(state.getReplay("scope", "first", 10)).toBeNull();
    expect(state.getReplay("scope", "second", 10)).toBe("mctc_2");
    expect(state.getReplay("scope", "third", 20)).toBeNull();
  });
});

function testSession(
  sessionId: string,
  replayScope: string,
  subject: string,
  clientId = "mcpc_1",
): McpStateSession {
  return {
    subject,
    replayScope,
    context: {
      principal: { kind: "user", subject },
      venue: "mcp",
      presence: "present",
      sessionId,
      mcpConsent: { clientId, scopes: ["read", "write"] },
    },
    async handleRequest() {
      return new Response();
    },
    async close() {},
  };
}
