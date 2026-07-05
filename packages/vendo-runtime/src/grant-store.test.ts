import { describe, expect, it } from "vitest";
import { createInMemoryGrantStore } from "./grant-store";

const scope = { tenantId: "t", subject: "u" };
const other = { tenantId: "t", subject: "someone-else" };
const draft = {
  tool: "send_email", descriptorHash: "h", scope: { kind: "tool" as const },
  duration: "standing" as const, source: { kind: "fade" as const },
};

describe("InMemoryGrantStore", () => {
  it("assigns id/grantedAt and scopes by principal", async () => {
    const store = createInMemoryGrantStore({ now: () => "2026-07-04T00:00:00Z" });
    const g = await store.create(scope, draft);
    expect(g.id).toBeTruthy();
    expect(g.grantedAt).toBe("2026-07-04T00:00:00Z");
    expect(await store.list(scope)).toHaveLength(1);
    expect(await store.list(other)).toHaveLength(0);
    expect(await store.findForTool(scope, "send_email")).toHaveLength(1);
    expect(await store.findForTool(scope, "other")).toHaveLength(0);
  });
  it("revoke stamps revokedAt and drops it from findForTool", async () => {
    const store = createInMemoryGrantStore({ now: () => "2026-07-04T00:00:00Z" });
    const g = await store.create(scope, draft);
    await store.revoke(scope, g.id);
    expect(await store.findForTool(scope, "send_email")).toHaveLength(0);
    expect((await store.list(scope))[0]!.revokedAt).toBeTruthy();
  });
});
