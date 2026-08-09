/**
 * THE MOUNT POINT HAS TO REACH THE AGENT'S TOOL CALLS.
 *
 * Maple is served in place at demos.vendo.run/maple, so the endpoints really
 * live at `<origin>/maple/api/…`. Next rewrites the app's own requests; it does
 * not know the agent exists. The prefix travels `openapi.json` servers →
 * `vendo sync` → `.vendo/tools.json` `binding.path`, and NOTHING a human can
 * see depends on it: get it wrong and every page renders perfectly while every
 * number the agent quotes is a 404. That is why this is asserted rather than
 * eyeballed.
 *
 * Spec 2026-08-06 §B1 moved the prefix's home: stored paths are PREFIX-FREE and
 * VENDO_BASE_URL carries the whole public URL, which core's joinUrl attaches
 * exactly once at call time.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { joinUrl } from "@vendoai/core";
import { config } from "../../../src/proxy";
import spec from "../../../openapi.json";
import tools from "../../../.vendo/tools.json";
import { doorUrls, signIn } from "../../../scripts/mcp-oauth";
import { BASE_PATH } from "@/lib/base-path";

afterEach(() => vi.unstubAllGlobals());

const PUBLIC_URL = `http://localhost:3000${BASE_PATH}`;

describe("Maple's mount point", () => {
  it("is what the spec declares as its server", () => {
    expect(spec.servers).toEqual([{ url: BASE_PATH }]);
  });

  /** Spec 2026-08-06 §B1: stored paths are PREFIX-FREE. The prefix lives in
   *  VENDO_BASE_URL and core's joinUrl attaches it exactly once at call time —
   *  baking it into tools.json is what produced /maple/maple/… (#914). */
  it("stores every binding path prefix-free", () => {
    expect(tools.tools.length).toBeGreaterThan(0);
    for (const { name, binding } of tools.tools) {
      expect(binding.path.startsWith(`${BASE_PATH}/`), `${name}: ${binding.method} ${binding.path}`).toBe(false);
      expect(binding.path.startsWith("/"), `${name}: ${binding.method} ${binding.path}`).toBe(true);
    }
  });

  /** …and the runtime's join puts it back exactly once, which is the property
   *  the agent's tool calls actually depend on. */
  it("reaches the real endpoint once the public URL is joined on", () => {
    for (const { name, binding } of tools.tools) {
      const url = joinUrl(PUBLIC_URL, binding.path.replace(/\{[^}]+\}/g, "x"));
      expect(url.pathname.startsWith(`${BASE_PATH}/`), `${name}: ${url.pathname}`).toBe(true);
      expect(url.pathname.startsWith(`${BASE_PATH}${BASE_PATH}/`), `${name}: ${url.pathname}`).toBe(false);
    }
  });

  /** Also catches a STALE tools.json — a spec edit that never got synced. */
  it("covers every documented operation exactly once", () => {
    const documented = Object.entries(spec.paths as Record<string, Record<string, unknown>>)
      .flatMap(([path, item]) => Object.keys(item).map(method => `${method.toUpperCase()} ${path}`))
      .sort();
    const synced = tools.tools
      .filter(tool => tool.binding.kind === "openapi")
      .map(tool => `${tool.binding.method} ${tool.binding.path}`)
      .sort();
    expect(synced).toEqual(documented);
  });

  /** THE MCP DOOR IS UNDER THE MOUNT POINT TOO, and the same nothing-visible
   *  rule applies: an origin-rooted discovery URL reaches Maple's 404 PAGE, and
   *  a 404 page is an HTML body a walk can read right past. The door, its two
   *  discovery documents and the login it bounces to all live under the prefix
   *  — the door advertises the prefix-LOCAL well-known spelling, because a
   *  mounted deployment owns no path outside its prefix. */
  it("roots the MCP door walk — resource, discovery, login — at the mount point", () => {
    const walk = {
      base: `http://localhost:3000${BASE_PATH}`,
      resource: `http://localhost:3000${BASE_PATH}/api/vendo/mcp`,
      protectedResourceMetadata: `http://localhost:3000${BASE_PATH}/.well-known/oauth-protected-resource/api/vendo/mcp`,
      authorizationServerMetadata: `http://localhost:3000${BASE_PATH}/.well-known/oauth-authorization-server/api/vendo/mcp`,
      login: `http://localhost:3000${BASE_PATH}/login`,
    };
    // No argument at all is the same walk: the default target is the dev
    // server's origin, not a bare origin the door does not answer on.
    expect(doorUrls(undefined)).toEqual(walk);
    expect(doorUrls("http://localhost:3000")).toEqual(walk);
    expect(doorUrls("http://localhost:3000/maple")).toEqual(walk);
  });

  /** …AND THE AUTHORIZATION SERVER MAY NOT BE UNDER THE MOUNT POINT AT ALL.
   *  Maple's own door names itself as its authorization server, so its
   *  metadata is the prefix-local document beside the protected-resource one.
   *  A broker-fronted deployment (`VENDO_MCP_REMOTE_AS_ISSUER`) names
   *  `{tenant}.mcp.vendo.run` instead and 404s its own metadata route — so the
   *  walk must read the server the protected-resource document ADVERTISES
   *  (RFC 9728 §3.3), never one derived from where the door sits. */
  it("follows the advertised authorization server off Maple's origin when a broker fronts the door", async () => {
    const walk = doorUrls("http://localhost:3000");
    const broker = "https://maple.mcp.vendo.run";
    const brokerMetadata = `${broker}/.well-known/oauth-authorization-server`;
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === walk.protectedResourceMetadata) {
        return Response.json({ resource: walk.resource, authorization_servers: [broker] });
      }
      if (url === brokerMetadata) {
        return Response.json({
          issuer: broker,
          authorization_endpoint: `${broker}/authorize`,
          token_endpoint: `${broker}/token`,
          registration_endpoint: `${broker}/register`,
          code_challenge_methods_supported: ["S256"],
        });
      }
      return new Response("Maple's 404 page", { status: 404 });
    });

    // The walk cannot COMPLETE against a broker — the broker owns the sign-in
    // pages this script types into. Discovery still has to get there.
    await expect(signIn("http://localhost:3000", "mount-point test")).rejects.toThrow();
    expect(requested.slice(0, 2)).toEqual([walk.protectedResourceMetadata, brokerMetadata]);
  });

  /** Next prefixes every proxy matcher with the mount point, so the catch-all
   *  becomes `/maple/((?!…).*)` and does not match the bare `/maple` a visitor
   *  types. Dropping the explicit "/" leaves the home page as the one page the
   *  auth gate never sees — and it renders a signed-out visitor a signed-in
   *  page. */
  it("is covered by the proxy matcher at its bare root", () => {
    expect(config.matcher).toContain("/");
  });
});
