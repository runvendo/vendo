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
): McpStateSession {
  return {
    subject,
    replayScope,
    context: {
      principal: { kind: "user", subject },
      venue: "mcp",
      presence: "present",
      sessionId,
      mcpConsent: { clientId: "mcpc_1", scopes: ["read", "write"] },
    },
    async handleRequest() {
      return new Response();
    },
    async close() {},
  };
}
