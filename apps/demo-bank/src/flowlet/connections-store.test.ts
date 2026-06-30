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

  it("starts with everything disconnected", () => {
    expect(connectedToolkits()).toEqual([]);
    expect(listIntegrations().every((i) => !i.connected)).toBe(true);
  });

  it("advertises a catalog of integrations with stable shape", () => {
    const list = listIntegrations();
    expect(list.length).toBeGreaterThan(0);
    const gmail = list.find((i) => i.id === "gmail");
    expect(gmail).toMatchObject({ id: "gmail", name: "Gmail", connected: false });
  });

  it("connect/disconnect flips the connected flag and toolkit list", () => {
    connect("gmail");
    expect(connectedToolkits()).toContain("gmail");
    expect(listIntegrations().find((i) => i.id === "gmail")?.connected).toBe(true);

    disconnect("gmail");
    expect(connectedToolkits()).not.toContain("gmail");
    expect(listIntegrations().find((i) => i.id === "gmail")?.connected).toBe(false);
  });

  it("ignores unknown ids on connect", () => {
    connect("not-a-real-tool");
    expect(connectedToolkits()).toEqual([]);
  });

  it("resetConnections disconnects everything", () => {
    connect("gmail");
    connect("slack");
    resetConnections();
    expect(connectedToolkits()).toEqual([]);
  });
});
