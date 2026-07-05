import { describe, expect, it } from "vitest";
import { InProcessCredentialBroker } from "./in-process-credential-broker.js";

const nowMs = () => Date.parse("2026-07-02T00:00:00.000Z");

describe("InProcessCredentialBroker", () => {
  it("authenticates a Principal-shaped credential as a pass-through", async () => {
    const broker = new InProcessCredentialBroker({ nowMs });
    const principal = await broker.authenticate({ tenantId: "t1", subject: "u1" });
    expect(principal).toEqual({ tenantId: "t1", subject: "u1" });
  });

  it("preserves claims on the authenticated principal", async () => {
    const broker = new InProcessCredentialBroker({ nowMs });
    const principal = await broker.authenticate({
      tenantId: "t1",
      subject: "u1",
      claims: { name: "Yousef" },
    });
    expect(principal.claims).toEqual({ name: "Yousef" });
  });

  it("rejects a credential that is not Principal-shaped (fail closed)", async () => {
    const broker = new InProcessCredentialBroker({ nowMs });
    await expect(broker.authenticate("a-jwt-string")).rejects.toThrow(/principal/i);
    await expect(broker.authenticate({ tenantId: "t1" })).rejects.toThrow(/principal/i);
  });

  it("acquireGrant returns the ambient identity with the requested scopes and an expiry", async () => {
    const broker = new InProcessCredentialBroker({ nowMs, grantTtlMs: 60_000 });
    const grant = await broker.acquireGrant({
      principal: { tenantId: "t1", subject: "u1" },
      automationId: "auto-1",
      scopes: ["transactions:read"],
    });
    expect(grant.token).toBe("embedded:t1:u1:auto-1");
    expect(grant.scopes).toEqual(["transactions:read"]);
    expect(grant.expiresAt).toBe("2026-07-02T00:01:00.000Z");
  });
});
