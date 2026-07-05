import { describe, it, expect } from "vitest";
import { parseHandlerOptions } from "./options";

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
