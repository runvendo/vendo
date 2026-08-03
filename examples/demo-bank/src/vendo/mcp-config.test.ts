import { describe, expect, it } from "vitest";
import { mapleMcpConfig } from "./mcp-config";

describe("mapleMcpConfig", () => {
  it("keeps the local-AS door when no broker envs are set", () => {
    // Next's ProcessEnv augmentation makes NODE_ENV required; it carries no
    // signal for mapleMcpConfig, which reads only VENDO_MCP_* keys.
    expect(mapleMcpConfig({ NODE_ENV: "test" })).toBe(true);
  });

  it("trusts the broker issuer with the tenant-resource audience default", () => {
    expect(mapleMcpConfig({
      NODE_ENV: "test",
      VENDO_MCP_REMOTE_AS_ISSUER: "https://maple.mcp.vendo.run",
      VENDO_MCP_FEDERATION_SECRET: "tenant-federation-secret",
    })).toEqual({
      remoteAs: {
        issuer: "https://maple.mcp.vendo.run",
        audience: "https://maple.mcp.vendo.run/mcp",
      },
      federation: { secret: "tenant-federation-secret" },
    });
  });

  it("honors explicit audience and JWKS overrides, and omits federation without a secret", () => {
    expect(mapleMcpConfig({
      NODE_ENV: "test",
      VENDO_MCP_REMOTE_AS_ISSUER: "https://maple.mcp.vendo.run/",
      VENDO_MCP_REMOTE_AS_AUDIENCE: "https://maple.mcp.vendo.run/mcp",
      VENDO_MCP_REMOTE_AS_JWKS_URI: "http://127.0.0.1:4310/.well-known/jwks.json",
    })).toEqual({
      remoteAs: {
        issuer: "https://maple.mcp.vendo.run/",
        audience: "https://maple.mcp.vendo.run/mcp",
        jwksUri: "http://127.0.0.1:4310/.well-known/jwks.json",
      },
    });
  });
});
