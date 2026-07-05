import { describe, it, expect, vi } from "vitest";
import { mcpJsonSchema, resolveMcpServers } from "./mcp-config";

describe("mcpJsonSchema", () => {
  it("accepts a valid file shape", () => {
    const parsed = mcpJsonSchema.safeParse({
      version: 1,
      servers: [
        {
          name: "weather",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer ${WEATHER_TOKEN}" },
          tools: ["get_forecast"],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a server name that is not a valid tool-name fragment", () => {
    expect(
      mcpJsonSchema.safeParse({ version: 1, servers: [{ name: "bad name!", url: "https://x" }] })
        .success,
    ).toBe(false);
  });

  it("rejects non-http(s) URLs", () => {
    expect(
      mcpJsonSchema.safeParse({ version: 1, servers: [{ name: "s", url: "file:///etc/passwd" }] })
        .success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(
      mcpJsonSchema.safeParse({
        version: 1,
        servers: [{ name: "s", url: "https://x", transport: "stdio" }],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate server names", () => {
    expect(
      mcpJsonSchema.safeParse({
        version: 1,
        servers: [
          { name: "dup", url: "https://a" },
          { name: "dup", url: "https://b" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects prefix-ambiguous server names ('a' and 'a_b' can collide on prefixed tool names)", () => {
    expect(
      mcpJsonSchema.safeParse({
        version: 1,
        servers: [
          { name: "a", url: "https://a" },
          { name: "a_b", url: "https://ab" },
        ],
      }).success,
    ).toBe(false);
    // Non-underscore extension is fine: "shop" and "shopify" cannot collide.
    expect(
      mcpJsonSchema.safeParse({
        version: 1,
        servers: [
          { name: "shop", url: "https://a" },
          { name: "shopify", url: "https://b" },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("resolveMcpServers", () => {
  it("substitutes ${ENV_VAR} in header values", () => {
    const resolved = resolveMcpServers(
      [{ name: "s", url: "https://x", headers: { Authorization: "Bearer ${TOK}" } }],
      { TOK: "abc123" },
    );
    expect(resolved).toEqual([
      { name: "s", url: "https://x", headers: { Authorization: "Bearer abc123" } },
    ]);
  });

  it("drops a server (with a warning) when a referenced env var is missing or empty", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = resolveMcpServers(
      [
        { name: "broken", url: "https://x", headers: { Authorization: "Bearer ${NOPE}" } },
        { name: "ok", url: "https://y" },
      ],
      {},
    );
    expect(resolved.map((s) => s.name)).toEqual(["ok"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"broken"'));
    warn.mockRestore();
  });

  it("passes through servers with no headers untouched", () => {
    expect(resolveMcpServers([{ name: "s", url: "https://x", tools: ["a"] }], {})).toEqual([
      { name: "s", url: "https://x", tools: ["a"] },
    ]);
  });

  it("drops a server whose header still contains an unresolved ${...} template (lowercase/dashed refs)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = resolveMcpServers(
      [
        { name: "typo", url: "https://x", headers: { Authorization: "Bearer ${mcp_token}" } },
        { name: "ok", url: "https://y" },
      ],
      { mcp_token: "should-not-be-read" },
    );
    expect(resolved.map((s) => s.name)).toEqual(["ok"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"typo"'));
    warn.mockRestore();
  });
});
