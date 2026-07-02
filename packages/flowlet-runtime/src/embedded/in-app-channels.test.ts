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

  it("rejects non in-app channels (embedded is in-app only, fail closed)", async () => {
    const channels = new InAppChannels();
    await expect(channels.deliver({ ...message, channel: "sms" })).rejects.toThrow(/in-app/i);
    expect(channels.delivered).toHaveLength(0);
  });
});
