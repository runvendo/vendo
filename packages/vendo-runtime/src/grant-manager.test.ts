import { describe, expect, it } from "vitest";
import { createGrantManager } from "./grant-manager";
import { createInMemoryGrantStore } from "./grant-store";
import { InMemoryAuditLog } from "./embedded/in-memory-store";
import { hashDescriptor } from "./automations/grants";
import type { ToolDescriptor } from "./descriptor";

const scope = { tenantId: "t", subject: "u" };

const actDesc: ToolDescriptor = {
  name: "send_email", source: "caller",
  annotations: { readOnlyHint: false }, hasExecute: true, kind: "function",
};
const criticalDesc: ToolDescriptor = {
  name: "transfer_money", source: "caller",
  annotations: { destructiveHint: true }, hasExecute: true, kind: "function",
};

describe("grant manager", () => {
  it("creates a grant with the descriptor-derived hash and appends grant_created", async () => {
    const store = createInMemoryGrantStore();
    const audit = new InMemoryAuditLog();
    const mgr = createGrantManager({ store, audit, now: () => "2026-07-04T00:00:00Z" });
    const g = await mgr.create(scope, {
      tool: "send_email",
      scope: { kind: "constrained", constraints: [{ path: "to", op: "matches", value: "*@acme.co" }] },
      duration: "standing", source: { kind: "fade" },
    }, actDesc);
    expect(g.id).toBeTruthy();
    expect(g.descriptorHash).toBe(hashDescriptor(actDesc));
    const rows = await audit.query(scope, { kinds: ["grant_created"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "send_email", scopePreview: 'to matches "*@acme.co"' });
  });
  it("refuses to create a grant for a critical (destructiveHint) descriptor", async () => {
    const mgr = createGrantManager({ store: createInMemoryGrantStore(), audit: new InMemoryAuditLog() });
    await expect(
      mgr.create(scope, {
        tool: "transfer_money", scope: { kind: "tool" },
        duration: "standing", source: { kind: "chat" },
      }, criticalDesc),
    ).rejects.toThrow(/critical/);
  });
  it("revoke appends grant_revoked", async () => {
    const store = createInMemoryGrantStore();
    const audit = new InMemoryAuditLog();
    const mgr = createGrantManager({ store, audit });
    const g = await mgr.create(scope, { tool: "send_email", scope: { kind: "tool" }, duration: "standing", source: { kind: "chat" } }, actDesc);
    await mgr.revoke(scope, g.id);
    expect(await audit.query(scope, { kinds: ["grant_revoked"] })).toHaveLength(1);
    expect(await store.findForTool(scope, "send_email")).toHaveLength(0);
  });
  it("revoke of a missing or already-revoked grant appends nothing", async () => {
    const store = createInMemoryGrantStore();
    const audit = new InMemoryAuditLog();
    const mgr = createGrantManager({ store, audit });
    await mgr.revoke(scope, "no-such-grant");
    const g = await mgr.create(scope, { tool: "send_email", scope: { kind: "tool" }, duration: "standing", source: { kind: "chat" } }, actDesc);
    await mgr.revoke(scope, g.id);
    await mgr.revoke(scope, g.id); // double revoke: no second event
    expect(await audit.query(scope, { kinds: ["grant_revoked"] })).toHaveLength(1);
  });
});
