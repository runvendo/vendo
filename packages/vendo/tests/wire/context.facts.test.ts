import type { Json, Principal } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createContextResolver } from "../../src/wire/context.js";
import type { WireDeps } from "../../src/wire/shared.js";

/** Spec 2026-08-05 §1 — the wire resolves the preset's facts seam once per
    request and stashes the result as ctx.user (the prompt's [User] block). */

const request = (): Request => new Request("https://host.test/api/vendo/threads");

const depsFor = (over: {
  principal: Principal;
  userFacts?: (req: Request) => Promise<Record<string, Json> | undefined>;
}): WireDeps => ({
  principal: async () => over.principal,
  ...(over.userFacts === undefined ? {} : { userFacts: over.userFacts }),
  trustedBaseIsHttps: false,
  sessionId: "sess_wire",
} as unknown as WireDeps);

describe("spec 2026-08-05 §1 — user facts on the wire ctx", () => {
  it("stashes the seam's facts as ctx.user", async () => {
    const resolve = createContextResolver(
      depsFor({
        principal: { kind: "user", subject: "mia" },
        userFacts: async () => ({ name: "Mia", plan: "Pro" }),
      }),
    );
    expect((await resolve(request(), "chat")).user).toEqual({ name: "Mia", plan: "Pro" });
  });

  it("leaves ctx.user absent when no seam is wired, or when it asserts nothing", async () => {
    const bare = createContextResolver(depsFor({ principal: { kind: "user", subject: "mia" } }));
    expect((await bare(request(), "chat")).user).toBeUndefined();
    const empty = createContextResolver(
      depsFor({ principal: { kind: "user", subject: "mia" }, userFacts: async () => undefined }),
    );
    expect((await empty(request(), "chat")).user).toBeUndefined();
  });
});
