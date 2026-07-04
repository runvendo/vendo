import { describe, expect, it } from "vitest";
import { demoStore, resolveThreadRecordId } from "./store";
import { CADENCE_SCOPE } from "./automations";

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
});
