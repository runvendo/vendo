import { describe, it, expect } from "vitest";
import { parseHandlerOptions } from "./options.js";

describe("parseHandlerOptions: mcpServers", () => {
  it("accepts mcpServers", () => {
    expect(() =>
      parseHandlerOptions({
        mcpServers: [
          {
            name: "weather",
            url: "https://mcp.example.com/mcp",
            headers: { Authorization: "Bearer x" },
            tools: ["get_forecast"],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects an mcpServers entry with a bad name or unknown key", () => {
    expect(() =>
      parseHandlerOptions({ mcpServers: [{ name: "bad name", url: "https://x" }] }),
    ).toThrow(/invalid options/);
    expect(() =>
      parseHandlerOptions({
        mcpServers: [{ name: "s", url: "https://x", transport: "stdio" } as never],
      }),
    ).toThrow(/invalid options/);
  });

  it("rejects duplicate MCP server names", () => {
    expect(() =>
      parseHandlerOptions({
        mcpServers: [
          { name: "dup", url: "https://a" },
          { name: "dup", url: "https://b" },
        ],
      }),
    ).toThrow(/invalid options/);
  });
});

describe("parseHandlerOptions storage", () => {
  it("accepts a connectionString", () => {
    expect(() =>
      parseHandlerOptions({ storage: { connectionString: "postgres://x" } }),
    ).not.toThrow();
  });

  it("accepts a pglite dataDir", () => {
    expect(() =>
      parseHandlerOptions({ storage: { pglite: { dataDir: "./.vendo/data" } } }),
    ).not.toThrow();
  });

  it("accepts autoMigrate alongside a connectionString", () => {
    expect(() =>
      parseHandlerOptions({ storage: { connectionString: "postgres://x", autoMigrate: false } }),
    ).not.toThrow();
  });

  it("accepts false (in-memory)", () => {
    expect(() => parseHandlerOptions({ storage: false })).not.toThrow();
  });

  it("accepts no storage option at all", () => {
    expect(() => parseHandlerOptions({})).not.toThrow();
  });

  it("rejects a non-object, non-false storage value", () => {
    expect(() => parseHandlerOptions({ storage: 42 } as never)).toThrow(/invalid options/);
  });

  it("rejects an unknown storage key", () => {
    expect(() => parseHandlerOptions({ storage: { bogus: true } } as never)).toThrow(/invalid options/);
  });
});

describe("parseHandlerOptions: connections", () => {
  const fullStore = {
    list: async () => [],
    connect: async () => undefined,
    disconnect: async () => undefined,
    connectedToolkits: async () => [],
    setConnectedAccount: async () => undefined,
    findByConnectedAccount: async () => undefined,
  };

  it("accepts a store implementing all six ConnectionsStore methods", () => {
    expect(() => parseHandlerOptions({ connections: fullStore as never })).not.toThrow();
  });

  it("rejects a legacy store missing the newer methods (would throw at runtime instead of boot)", () => {
    // Pre-webhooks shape: list + connectedToolkits only — integrations calls
    // connect/disconnect/setConnectedAccount and webhooks calls
    // findByConnectedAccount, so this must fail AT BOOT, readably.
    const legacy = {
      list: fullStore.list,
      connectedToolkits: fullStore.connectedToolkits,
    };
    expect(() => parseHandlerOptions({ connections: legacy as never })).toThrow(
      /connections store must implement/,
    );
  });

  it("rejects a store missing any single method", () => {
    for (const missing of Object.keys(fullStore)) {
      const partial = { ...fullStore } as Record<string, unknown>;
      delete partial[missing];
      expect(() => parseHandlerOptions({ connections: partial as never }), missing).toThrow(
        /invalid options/,
      );
    }
  });
});
