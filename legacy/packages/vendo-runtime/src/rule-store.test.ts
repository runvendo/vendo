import { describe, expect, it } from "vitest";
import { createInMemoryCompiledRuleStore } from "./rule-store.js";

const scope = { tenantId: "t", subject: "u" };
const other = { tenantId: "t", subject: "someone-else" };
const draft = { kind: "always_ask" as const, toolPattern: "send_email", plainText: "sending any email" };

describe("InMemoryCompiledRuleStore", () => {
  it("assigns id/createdAt and scopes by principal", async () => {
    const store = createInMemoryCompiledRuleStore({ now: () => "2026-07-04T00:00:00Z" });
    const r = await store.create(scope, draft);
    expect(r.id).toBeTruthy();
    expect(r.createdAt).toBe("2026-07-04T00:00:00Z");
    expect(await store.list(scope)).toHaveLength(1);
    expect(await store.list(other)).toHaveLength(0);
  });
  it("revoke stamps revokedAt; list still returns the row (soft-revoke)", async () => {
    const store = createInMemoryCompiledRuleStore({ now: () => "2026-07-04T00:00:00Z" });
    const r = await store.create(scope, draft);
    await store.revoke(scope, r.id);
    const rows = await store.list(scope);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeTruthy();
  });
  it("revoke is a no-op for a foreign or unknown id", async () => {
    const store = createInMemoryCompiledRuleStore();
    const r = await store.create(scope, draft);
    await store.revoke(other, r.id); // wrong principal — must not revoke
    expect((await store.list(scope))[0]!.revokedAt).toBeUndefined();
    await store.revoke(scope, "not-real"); // unknown id — must not throw
  });
});
