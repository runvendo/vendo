import { describe, expect, it } from "vitest";
import { CADENCE_SCOPE, demoStore, resetDemoStore, resolveThreadRecordId } from "./store";

describe("demo store + thread id mapping", () => {
  it("has grants and audit wired (item-1 primitives)", async () => {
    expect(demoStore.grants).toBeDefined();
    expect(demoStore.audit).toBeDefined();
  });

  it("maps a client-stable thread id to a store-assigned ThreadRecord id, stably", async () => {
    const a = await resolveThreadRecordId(CADENCE_SCOPE, "cadence-demo");
    const b = await resolveThreadRecordId(CADENCE_SCOPE, "cadence-demo");
    expect(a).toBe(b);
    const other = await resolveThreadRecordId(CADENCE_SCOPE, "other-thread");
    expect(other).not.toBe(a);
  });

  it("resetDemoStore revokes live grants AND live rules (ENG-193 item 6)", async () => {
    await demoStore.grants.create(CADENCE_SCOPE, {
      tool: "sendClientMessage", descriptorHash: "h1", scope: { kind: "tool" }, duration: "standing",
      source: { kind: "chat" },
    });
    await demoStore.rules.create(CADENCE_SCOPE, {
      kind: "always_ask", toolPattern: "sendClientMessage", plainText: "sending client messages",
    });
    await resetDemoStore();
    expect(await demoStore.grants.findForTool(CADENCE_SCOPE, "sendClientMessage")).toHaveLength(0);
    expect((await demoStore.rules.list(CADENCE_SCOPE)).filter((r) => r.revokedAt === undefined)).toHaveLength(0);
  });
});
