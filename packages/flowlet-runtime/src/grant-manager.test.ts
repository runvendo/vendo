import { describe, expect, it } from "vitest";
import { createGrantManager } from "./grant-manager";
import { createInMemoryGrantStore } from "./grant-store";
import { InMemoryAuditLog } from "./embedded/in-memory-store";

const scope = { tenantId: "t", subject: "u" };

describe("grant manager", () => {
  it("creates a grant and appends grant_created", async () => {
    const store = createInMemoryGrantStore();
    const audit = new InMemoryAuditLog();
    const mgr = createGrantManager({ store, audit, now: () => "2026-07-04T00:00:00Z" });
    const g = await mgr.create(scope, {
      tool: "send_email", descriptorHash: "h",
      scope: { kind: "constrained", constraints: [{ path: "to", op: "matches", value: "*@acme.co" }] },
      duration: "standing", source: { kind: "fade" },
    });
    expect(g.id).toBeTruthy();
    const rows = await audit.query(scope, { kinds: ["grant_created"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "send_email", scopePreview: 'to matches "*@acme.co"' });
  });
  it("refuses to create a grant for a critical descriptor", async () => {
    const mgr = createGrantManager({ store: createInMemoryGrantStore(), audit: new InMemoryAuditLog() });
    await expect(
      mgr.create(scope, {
        tool: "transfer_money", descriptorHash: "h", scope: { kind: "tool" },
        duration: "standing", source: { kind: "chat" },
      }, { critical: true }),
    ).rejects.toThrow(/critical/);
  });
  it("revoke appends grant_revoked", async () => {
    const store = createInMemoryGrantStore();
    const audit = new InMemoryAuditLog();
    const mgr = createGrantManager({ store, audit });
    const g = await mgr.create(scope, { tool: "t", descriptorHash: "h", scope: { kind: "tool" }, duration: "standing", source: { kind: "chat" } });
    await mgr.revoke(scope, g.id);
    expect(await audit.query(scope, { kinds: ["grant_revoked"] })).toHaveLength(1);
    expect(await store.findForTool(scope, "t")).toHaveLength(0);
  });
});
