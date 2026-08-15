import type { Principal } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createContextResolver } from "../../src/wire/context.js";
import type { WireDeps } from "../../src/wire/shared.js";

/** Limits — the wire resolves the preset's pools seam once per request and
    stashes the keys as ctx.pools (the shared meters usage also counts into). */

const request = (): Request => new Request("https://host.test/api/vendo/threads");

const depsFor = (over: {
  principal: Principal;
  userPools?: (req: Request) => Promise<Record<string, string> | undefined>;
}): WireDeps => ({
  principal: async () => over.principal,
  ...(over.userPools === undefined ? {} : { userPools: over.userPools }),
  trustedBaseIsHttps: false,
  sessionId: "sess_wire",
} as unknown as WireDeps);

describe("limits — the user's pools on the wire ctx", () => {
  it("stashes the seam's pool keys as ctx.pools", async () => {
    const resolve = createContextResolver(
      depsFor({
        principal: { kind: "user", subject: "mia" },
        userPools: async () => ({ workspace: "ws_maple" }),
      }),
    );
    expect((await resolve(request(), "chat")).pools).toEqual({ workspace: "ws_maple" });
  });

  it("leaves ctx.pools absent when no seam is wired, or when it asserts nothing", async () => {
    const bare = createContextResolver(depsFor({ principal: { kind: "user", subject: "mia" } }));
    expect((await bare(request(), "chat")).pools).toBeUndefined();
    const empty = createContextResolver(
      depsFor({ principal: { kind: "user", subject: "mia" }, userPools: async () => undefined }),
    );
    expect((await empty(request(), "chat")).pools).toBeUndefined();
  });
});
