import { describe, expect, it } from "vitest";
import type { Vendo } from "@vendoai/shell";
import {
  createDrizzleVendoRegistry,
  createInMemoryVendoRegistry,
  handleVendosGet,
  handleVendosPost,
  type VendoRegistry,
} from "./vendos.js";
import { createVendoDatabase, migrateVendoDatabase } from "@vendoai/store";
import type { VendoHandlerOptions } from "./options.js";

const scope = { tenantId: "vendo-embedded", subject: "u1" };
const other = { tenantId: "vendo-embedded", subject: "u2" };

const draft = (id: string, name: string): Vendo & { updatedAt: number } => ({
  id,
  name,
  node: { kind: "component", id: "n1", name: "Text", props: {} } as never,
  prompt: "show my spend",
  updatedAt: Date.now(),
});

function req(pathname: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3000${pathname}`, {
    headers: { host: "localhost:3000" },
    ...init,
  });
}

function options(userId: string | null): VendoHandlerOptions {
  return { principal: async () => (userId ? { userId } : null) };
}

function endpointSuite(makeRegistry: () => VendoRegistry | Promise<VendoRegistry>) {
  return async () => {
    const registry = await makeRegistry();

    const saved = await handleVendosPost(
      req("/api/vendo/vendos", { method: "POST", body: JSON.stringify(draft("f1", "first")) }),
      "vendos",
      { registry, options: options("u1") },
    );
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as Vendo;
    expect(savedBody.id).toBe("f1");
    expect(typeof savedBody.createdAt).toBe("number");
    expect(typeof savedBody.updatedAt).toBe("number");

    const list = await handleVendosGet(req("/api/vendo/vendos"), "vendos", {
      registry,
      options: options("u1"),
    });
    expect((await list.json()) as Vendo[]).toEqual([savedBody]);

    const one = await handleVendosGet(req("/api/vendo/vendos/f1"), "vendos/f1", {
      registry,
      options: options("u1"),
    });
    expect(await one.json()).toEqual(savedBody);

    const missing = await handleVendosGet(req("/api/vendo/vendos/nope"), "vendos/nope", {
      registry,
      options: options("u1"),
    });
    expect(missing.status).toBe(404);

    // Principal isolation: a different subject sees nothing.
    const otherList = await handleVendosGet(req("/api/vendo/vendos"), "vendos", {
      registry,
      options: options("u2"),
    });
    expect(await otherList.json()).toEqual([]);

    // Re-save preserves createdAt, bumps updatedAt.
    const resaved = await handleVendosPost(
      req("/api/vendo/vendos", {
        method: "POST",
        body: JSON.stringify({ ...draft("f1", "renamed"), updatedAt: savedBody.updatedAt + 1000 }),
      }),
      "vendos",
      { registry, options: options("u1") },
    );
    const resavedBody = (await resaved.json()) as Vendo;
    expect(resavedBody.name).toBe("renamed");
    expect(resavedBody.createdAt).toBe(savedBody.createdAt);
    expect(resavedBody.updatedAt).toBe(savedBody.updatedAt + 1000);

    const del = await handleVendosPost(req("/api/vendo/vendos/f1/delete", { method: "POST" }), "vendos/f1/delete", {
      registry,
      options: options("u1"),
    });
    expect(del.status).toBe(200);
    const gone = await handleVendosGet(req("/api/vendo/vendos/f1"), "vendos/f1", {
      registry,
      options: options("u1"),
    });
    expect(gone.status).toBe(404);

    // No principal → 403, never a bare list.
    const anon = await handleVendosGet(req("/api/vendo/vendos"), "vendos", {
      registry,
      options: options(null),
    });
    expect(anon.status).toBe(403);

    // Percent-encoded ids: the client encodeURIComponent()s path ids, the
    // server must decode — an id with a space round-trips load AND delete.
    const spacedId = "f 2";
    const encoded = encodeURIComponent(spacedId);
    await handleVendosPost(
      req("/api/vendo/vendos", { method: "POST", body: JSON.stringify(draft(spacedId, "spaced")) }),
      "vendos",
      { registry, options: options("u1") },
    );
    const spacedLoad = await handleVendosGet(
      req(`/api/vendo/vendos/${encoded}`),
      `vendos/${encoded}`,
      { registry, options: options("u1") },
    );
    expect(spacedLoad.status).toBe(200);
    expect(((await spacedLoad.json()) as Vendo).id).toBe(spacedId);
    const spacedDelete = await handleVendosPost(
      req(`/api/vendo/vendos/${encoded}/delete`, { method: "POST" }),
      `vendos/${encoded}/delete`,
      { registry, options: options("u1") },
    );
    expect(spacedDelete.status).toBe(200);
    const spacedGone = await handleVendosGet(
      req(`/api/vendo/vendos/${encoded}`),
      `vendos/${encoded}`,
      { registry, options: options("u1") },
    );
    expect(spacedGone.status).toBe(404);
  };
}

describe("vendos endpoints — in-memory registry", () => {
  it("saves, lists, loads, deletes, and scopes by principal", endpointSuite(() => createInMemoryVendoRegistry()));
});

describe("vendos endpoints — reserved-id rejection (review blocker)", () => {
  it.each(["chat", "action", "integrations", "capabilities", "tick", "webhooks", "threads", "vendos"])(
    "rejects a save whose id equals the reserved segment %s",
    async (id) => {
      const registry = createInMemoryVendoRegistry();
      const res = await handleVendosPost(
        req("/api/vendo/vendos", { method: "POST", body: JSON.stringify(draft(id, "bad")) }),
        "vendos",
        { registry, options: options("u1") },
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/reserved/i);
      expect(await registry.list({ tenantId: "vendo-embedded", subject: "u1" })).toEqual([]);
    },
  );

  it("rejects a save whose id contains a slash", async () => {
    const registry = createInMemoryVendoRegistry();
    const res = await handleVendosPost(
      req("/api/vendo/vendos", { method: "POST", body: JSON.stringify(draft("a/b", "bad")) }),
      "vendos",
      { registry, options: options("u1") },
    );
    expect(res.status).toBe(400);
  });
});

describe("vendos endpoints — cross-site request rejection (CSRF)", () => {
  // A host `principal` resolver may authenticate via ambient cookies, so a
  // cross-site page could fire authenticated mutations. The mutating vendo
  // routes must reject cross-site browser provenance unless the request
  // carries a custom-header credential (which cross-site pages cannot set
  // without a CORS preflight this handler never grants).
  const save = (headers: Record<string, string>) =>
    handleVendosPost(
      req("/api/vendo/vendos", {
        method: "POST",
        headers: { host: "localhost:3000", ...headers },
        body: JSON.stringify(draft("f1", "first")),
      }),
      "vendos",
      { registry: createInMemoryVendoRegistry(), options: options("u1") },
    );

  it("rejects a save whose Origin does not match the request host", async () => {
    const registry = createInMemoryVendoRegistry();
    const res = await handleVendosPost(
      req("/api/vendo/vendos", {
        method: "POST",
        headers: { host: "localhost:3000", origin: "https://evil.example" },
        body: JSON.stringify(draft("f1", "first")),
      }),
      "vendos",
      { registry, options: options("u1") },
    );
    expect(res.status).toBe(403);
    expect(await registry.list({ tenantId: "vendo-embedded", subject: "u1" })).toEqual([]);
  });

  it("rejects a delete that declares sec-fetch-site: cross-site", async () => {
    const registry = createInMemoryVendoRegistry();
    await registry.save({ tenantId: "vendo-embedded", subject: "u1" }, draft("f1", "first"));
    const res = await handleVendosPost(
      req("/api/vendo/vendos/f1/delete", {
        method: "POST",
        headers: { host: "localhost:3000", "sec-fetch-site": "cross-site" },
      }),
      "vendos/f1/delete",
      { registry, options: options("u1") },
    );
    expect(res.status).toBe(403);
    expect(await registry.load({ tenantId: "vendo-embedded", subject: "u1" }, "f1")).not.toBeNull();
  });

  it("allows same-origin provenance (sec-fetch-site and matching Origin)", async () => {
    expect((await save({ "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await save({ origin: "http://localhost:3000" })).status).toBe(200);
  });

  it("allows a cross-site Origin when the request carries an authorization header (custom-header credentials are inherently CSRF-safe)", async () => {
    const res = await save({ origin: "https://evil.example", authorization: "Bearer token" });
    expect(res.status).toBe(200);
  });

  it("allows requests with no browser provenance headers (non-browser callers)", async () => {
    expect((await save({})).status).toBe(200);
  });
});

describe("vendos endpoints — Drizzle registry", () => {
  it(
    "saves, lists, loads, deletes, and scopes by principal (durable)",
    endpointSuite(async () => {
      const handle = await createVendoDatabase({
        pglite: { dataDir: `memory://vendo-next-vendos-${Date.now()}-${Math.random()}` },
      });
      await migrateVendoDatabase(handle);
      return createDrizzleVendoRegistry(handle);
    }),
  );

  it("orders list() by updatedAt descending and survives a fresh registry over the same handle", async () => {
    const handle = await createVendoDatabase({
      pglite: { dataDir: `memory://vendo-next-vendos-order-${Date.now()}` },
    });
    await migrateVendoDatabase(handle);
    const registry = createDrizzleVendoRegistry(handle);
    await registry.save(scope, { ...draft("a", "a"), updatedAt: 1 });
    await registry.save(scope, { ...draft("b", "b"), updatedAt: 2 });
    await registry.save(scope, { ...draft("c", "c"), updatedAt: 3 });
    await registry.save(other, { ...draft("z", "z"), updatedAt: 99 });

    const rebuilt = createDrizzleVendoRegistry(handle);
    const list = await rebuilt.list(scope);
    expect(list.map((f) => f.id)).toEqual(["c", "b", "a"]);
  });
});
