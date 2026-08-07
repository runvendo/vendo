import { describe, expect, it } from "vitest";
import { BASE_PATH } from "@/lib/base-path";
import { mapleMcpConfig } from "./mcp-config";

describe("mapleMcpConfig", () => {
  it("keeps the local-AS door when no broker envs are set", () => {
    // Next's ProcessEnv augmentation makes NODE_ENV required; it carries no
    // signal for mapleMcpConfig beyond the public base.
    expect(mapleMcpConfig({ NODE_ENV: "test" })).toBe(true);
  });

  /** Every URL the door advertises derives from the public base it was handed,
   *  and Next strips the mount point off a request before the route handler
   *  sees it — so a door handed the bare origin advertises
   *  `<origin>/api/vendo/mcp`, which 404s. Discovery is ALL a real MCP client
   *  has, so that is a dead door with a live-looking product. VENDO_BASE_URL
   *  stays the bare ORIGIN (host tool bindings concatenate it with paths that
   *  already carry the prefix); the mount goes on here and only here. */
  it("advertises the door at the mount point, not the bare origin", () => {
    expect(mapleMcpConfig({ NODE_ENV: "test", VENDO_BASE_URL: "https://maple.vendo.run" }))
      .toEqual({ baseUrl: `https://maple.vendo.run${BASE_PATH}` });
    expect(mapleMcpConfig({ NODE_ENV: "test", VENDO_BASE_URL: "https://maple.vendo.run/" }))
      .toEqual({ baseUrl: `https://maple.vendo.run${BASE_PATH}` });
  });

  it("carries the same public base into the broker-fronted door", () => {
    expect(mapleMcpConfig({
      NODE_ENV: "test",
      VENDO_BASE_URL: "https://maple.vendo.run",
      VENDO_MCP_REMOTE_AS_ISSUER: "https://maple.mcp.vendo.run",
    })).toEqual({
      baseUrl: `https://maple.vendo.run${BASE_PATH}`,
      remoteAs: {
        issuer: "https://maple.mcp.vendo.run",
        audience: "https://maple.mcp.vendo.run/mcp",
      },
    });
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
