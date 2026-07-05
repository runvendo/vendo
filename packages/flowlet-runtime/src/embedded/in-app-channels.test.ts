import { describe, expect, it } from "vitest";
import type { OutboundMessage } from "@flowlet/core";
import { InAppChannels } from "./in-app-channels";

const message: OutboundMessage = {
  channel: "in-app",
  principal: { tenantId: "t1", subject: "u1" },
  text: "Your automation fired",
  threadId: "thread-1",
};

describe("InAppChannels", () => {
  it("records in-app deliveries and invokes the host callback", async () => {
    const seen: OutboundMessage[] = [];
    const channels = new InAppChannels({ onDeliver: (m) => seen.push(m) });
    await channels.deliver(message);
    expect(channels.delivered).toEqual([message]);
    expect(seen).toEqual([message]);
  });

  it("awaits an async host callback and propagates its failure (delivery not recorded)", async () => {
    const channels = new InAppChannels({
      onDeliver: async () => {
        throw new Error("socket down");
      },
    });
    await expect(channels.deliver(message)).rejects.toThrow(/socket down/);
    expect(channels.delivered).toHaveLength(0);
  });

  it("rejects non in-app channels (embedded is in-app only, fail closed)", async () => {
    const channels = new InAppChannels();
    await expect(channels.deliver({ ...message, channel: "sms" })).rejects.toThrow(/in-app/i);
    expect(channels.delivered).toHaveLength(0);
  });

  it("retains deliveries with monotonic cursors, readable per principal since a cursor", async () => {
    const channels = new InAppChannels();
    const forOther: OutboundMessage = {
      ...message,
      principal: { tenantId: "t1", subject: "u2" },
      text: "not yours",
    };
    await channels.deliver(message);
    await channels.deliver(forOther);
    await channels.deliver({
      ...message,
      text: "Morning chase ran",
      automation: { kind: "completed", runId: "r1", summary: "2 sent" },
    });

    // From cursor 0: only u1's deliveries, in order, with increasing cursors.
    const all = channels.listSince({ tenantId: "t1", subject: "u1" }, 0);
    expect(all.map((d) => d.message.text)).toEqual(["Your automation fired", "Morning chase ran"]);
    expect(all[1]!.cursor).toBeGreaterThan(all[0]!.cursor);
    expect(all[1]!.message.automation?.runId).toBe("r1");

    // Since the first cursor: only the later delivery.
    const later = channels.listSince({ tenantId: "t1", subject: "u1" }, all[0]!.cursor);
    expect(later.map((d) => d.message.text)).toEqual(["Morning chase ran"]);

    // Other principal sees only their own.
    expect(
      channels.listSince({ tenantId: "t1", subject: "u2" }, 0).map((d) => d.message.text),
    ).toEqual(["not yours"]);
  });

  it("caps the retained delivery log, dropping oldest first", async () => {
    const channels = new InAppChannels({ retention: 3 });
    for (let i = 1; i <= 5; i++) await channels.deliver({ ...message, text: `m${i}` });
    const kept = channels.listSince(message.principal, 0);
    expect(kept.map((d) => d.message.text)).toEqual(["m3", "m4", "m5"]);
    // Cursors stay monotonic across the drop.
    expect(kept[0]!.cursor).toBeLessThan(kept[2]!.cursor);
  });
});
