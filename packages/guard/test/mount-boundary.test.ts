/**
 * ADVERSARIAL RE-CHECK on the mount boundary FIX (`startsWith(`${mount}/`)`).
 * A boundary fix has two ways to be wrong: it can still let a foreign path in,
 * and it can shut out a path that used to work. Both halves are here, plus the
 * shapes the fix's own reasoning turns on — the bare mount, a trailing slash,
 * a query string, an empty mount, and a mount that already ends in a slash.
 */
import { describe, expect, it } from "vitest";
import { createGuard, permissionsHandler } from "../src/index.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
import { alice } from "./fixtures/tools.js";

const askWrites = { rules: [{ match: { risk: "write" as const }, action: "ask" as const }] };
const guardOf = () => createGuard({ store: createMemoryStore(), policy: askWrites });

const handlerOn = (mount?: string) =>
  permissionsHandler({
    guard: guardOf(),
    principal: async () => alice,
    ...(mount === undefined ? {} : { mount }),
  });

const get = (path: string): Request => new Request(`https://app.example.com${path}`, { method: "GET" });

describe("RE-CHECK: the foreign path stays out", () => {
  it("a sibling that merely shares the mount's characters still falls through", async () => {
    const handler = handlerOn();

    expect(await handler(get("/api/vendoapprovals"))).toBeUndefined();
    expect(await handler(get("/api/vendogrants"))).toBeUndefined();
    expect(await handler(get("/api/vendo-legacy/approvals"))).toBeUndefined();
  });
});

describe("RE-CHECK: the bare mount itself", () => {
  it("answers nothing for the mount with no route on it, however it is spelled", async () => {
    const handler = handlerOn();

    // Not one of the five, so the host's own table gets its turn — never a 401
    // for a credential this handler is not owed, and never a 404 on the mount.
    expect(await handler(get("/api/vendo"))).toBeUndefined();
    expect(await handler(get("/api/vendo/"))).toBeUndefined();
    expect(await handler(get("/api/vendo?org=org_x"))).toBeUndefined();
    expect(await handler(get("/api/vendo/?org=org_x"))).toBeUndefined();
  });
});

describe("RE-CHECK: everything that worked before the fix still works", () => {
  it("the five on the default mount, with a trailing slash and with a query", async () => {
    const handler = handlerOn();

    expect((await handler(get("/api/vendo/approvals")))?.status).toBe(200);
    expect((await handler(get("/api/vendo/grants")))?.status).toBe(200);
    // filter(Boolean) has always eaten a trailing empty segment; the boundary
    // fix must not have taken that away.
    expect((await handler(get("/api/vendo/approvals/")))?.status).toBe(200);
    expect((await handler(get("/api/vendo/grants?limit=1")))?.status).toBe(200);
  });

  it("a custom mount without a trailing slash", async () => {
    const handler = handlerOn("/permissions");

    expect((await handler(get("/permissions/grants")))?.status).toBe(200);
    expect(await handler(get("/permissionsgrants"))).toBeUndefined();
    expect(await handler(get("/permissions"))).toBeUndefined();
  });

  it("a mount that already ends in a slash", async () => {
    // `mount` is a free-form string with no normalization and no documented
    // shape, so `/permissions/` is a spelling a host will write. It served the
    // five before the boundary fix; a silently dead permission surface is worse
    // than the hole the fix closed.
    const handler = handlerOn("/permissions/");

    expect((await handler(get("/permissions/grants")))?.status).toBe(200);
    // Normalization strips the host's slash rather than doubling it into the
    // boundary, and filter(Boolean) eats the empty segment, so the doubled
    // spelling nothing would ever send still lands on the same route.
    expect((await handler(get("/permissions//grants")))?.status).toBe(200);
  });

  it("an empty mount serves at the root", async () => {
    const handler = handlerOn("");

    expect((await handler(get("/grants")))?.status).toBe(200);
    expect(await handler(get("/healthz"))).toBeUndefined();
  });

  it("a root mount is the empty mount, not a doubled slash", async () => {
    // `/` is the OTHER spelling of the root, and the one a host actually writes.
    // Normalization takes it down to the empty mount, so the boundary is a bare
    // `/` that every path clears and the AREA check is what decides — not a
    // `//` that shuts the whole surface out.
    const handler = handlerOn("/");

    expect((await handler(get("/approvals")))?.status).toBe(200);
    expect((await handler(get("/grants")))?.status).toBe(200);
    expect(await handler(get("/healthz"))).toBeUndefined();
  });
});

describe("RE-CHECK: the door beside the five still falls through", () => {
  it("every path under the MCP door comes back undefined", async () => {
    const handler = handlerOn();

    expect(await handler(get("/api/vendo/mcp"))).toBeUndefined();
    expect(await handler(get("/api/vendo/mcp/message"))).toBeUndefined();
    expect(await handler(get("/api/vendo/threads"))).toBeUndefined();
  });
});
