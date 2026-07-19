import { describe, expect, it } from "vitest";
import { createFakeClient } from "./fake-client.js";
import { playgroundFixtures } from "./fixtures.js";

describe("playground fake client", () => {
  it("serves the wire fixtures without any network", async () => {
    const client = createFakeClient(playgroundFixtures());

    const threads = await client.threads.list();
    expect(threads.length).toBeGreaterThanOrEqual(2);

    const thread = await client.threads.get(threads[0]!.id);
    expect(thread.messages.length).toBeGreaterThan(0);

    const apps = await client.apps.list();
    expect(apps.length).toBeGreaterThanOrEqual(1);
    const surface = await client.apps.open(apps[0]!.id);
    expect(surface.kind).toBe("tree");

    const status = await client.status();
    expect(status.posture).not.toBe("unconfigured");

    expect((await client.connections.list()).length).toBeGreaterThanOrEqual(1);
    expect((await client.automations.list()).length).toBeGreaterThanOrEqual(1);
    expect((await client.activity.list()).length).toBeGreaterThanOrEqual(3);
  });

  it("approvals.decide resolves the pending approval so the queue empties", async () => {
    const client = createFakeClient(playgroundFixtures());
    const pending = await client.approvals.pending();
    expect(pending.length).toBeGreaterThanOrEqual(1);

    await client.approvals.decide(pending.map((approval) => approval.id), { approve: true });
    expect(await client.approvals.pending()).toEqual([]);
  });

  it("keeps state per instance — one scenario cannot leak into another", async () => {
    const first = createFakeClient(playgroundFixtures());
    const pending = await first.approvals.pending();
    await first.approvals.decide(pending[0]!.id, { approve: false });

    const second = createFakeClient(playgroundFixtures());
    expect((await second.approvals.pending()).length).toBe(pending.length);
  });

  it("connections.initiate answers with a local no-op redirect", async () => {
    const client = createFakeClient(playgroundFixtures());
    const initiated = await client.connections.initiate({ toolkit: "slack" });
    expect(initiated.redirectUrl).toContain("#");
  });
});
