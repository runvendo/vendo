import { describe, expect, it } from "vitest";
import { createRuleManager } from "./rule-manager";
import { createInMemoryCompiledRuleStore } from "./rule-store";
import { InMemoryAuditLog } from "./embedded/in-memory-store";

const scope = { tenantId: "t", subject: "u" };

describe("rule manager", () => {
  it("creates a rule and appends rule_created", async () => {
    const store = createInMemoryCompiledRuleStore();
    const audit = new InMemoryAuditLog();
    const mgr = createRuleManager({ store, audit, now: () => "2026-07-04T00:00:00Z" });
    const r = await mgr.create(scope, {
      kind: "always_ask", toolPattern: "send_email", plainText: "sending any email",
    });
    expect(r.id).toBeTruthy();
    const rows = await audit.query(scope, { kinds: ["rule_created"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toolPattern: "send_email", plainText: "sending any email" });
  });
  it("revoke appends rule_revoked", async () => {
    const store = createInMemoryCompiledRuleStore();
    const audit = new InMemoryAuditLog();
    const mgr = createRuleManager({ store, audit });
    const r = await mgr.create(scope, { kind: "always_ask", toolPattern: "t", plainText: "p" });
    await mgr.revoke(scope, r.id);
    expect(await audit.query(scope, { kinds: ["rule_revoked"] })).toHaveLength(1);
    expect((await store.list(scope))[0]!.revokedAt).toBeTruthy();
  });
  it("revoke of an unknown/already-revoked rule appends nothing spurious", async () => {
    const store = createInMemoryCompiledRuleStore();
    const audit = new InMemoryAuditLog();
    const mgr = createRuleManager({ store, audit });
    await mgr.revoke(scope, "not-real");
    expect(await audit.query(scope, { kinds: ["rule_revoked"] })).toHaveLength(0);
  });
});
