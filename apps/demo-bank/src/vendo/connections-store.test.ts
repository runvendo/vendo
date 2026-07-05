import { describe, it, expect, beforeEach } from "vitest";
import {
  listIntegrations,
  connect,
  disconnect,
  connectedToolkits,
  resetConnections,
} from "./connections-store";

describe("connections-store", () => {
  beforeEach(() => resetConnections());

  it("starts with everything disconnected", async () => {
    expect(await connectedToolkits()).toEqual([]);
    expect((await listIntegrations()).every((i) => !i.connected)).toBe(true);
  });

  it("advertises a catalog of integrations with stable shape", async () => {
    const list = await listIntegrations();
    expect(list.length).toBeGreaterThan(0);
    const gmail = list.find((i) => i.id === "gmail");
    expect(gmail).toMatchObject({ id: "gmail", name: "Gmail", connected: false });
  });

  it("connect/disconnect flips the connected flag and toolkit list", async () => {
    await connect("gmail");
    expect(await connectedToolkits()).toContain("gmail");
    expect((await listIntegrations()).find((i) => i.id === "gmail")?.connected).toBe(true);

    await disconnect("gmail");
    expect(await connectedToolkits()).not.toContain("gmail");
    expect((await listIntegrations()).find((i) => i.id === "gmail")?.connected).toBe(false);
  });

  it("ignores unknown ids on connect", async () => {
    await connect("not-a-real-tool");
    expect(await connectedToolkits()).toEqual([]);
  });

  it("resetConnections disconnects everything", async () => {
    await connect("gmail");
    await connect("slack");
    resetConnections();
    expect(await connectedToolkits()).toEqual([]);
  });
});
