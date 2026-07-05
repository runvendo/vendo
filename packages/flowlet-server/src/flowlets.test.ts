import { describe, expect, it } from "vitest";
import type { Flowlet } from "@flowlet/shell";
import {
  createDrizzleFlowletRegistry,
  createInMemoryFlowletRegistry,
  handleFlowletsGet,
  handleFlowletsPost,
  type FlowletRegistry,
} from "./flowlets";
import { createFlowletDatabase, migrateFlowletDatabase } from "@flowlet/store";
import type { FlowletHandlerOptions } from "./options";

const scope = { tenantId: "flowlet-embedded", subject: "u1" };
const other = { tenantId: "flowlet-embedded", subject: "u2" };

const draft = (id: string, name: string): Flowlet & { updatedAt: number } => ({
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

function options(userId: string | null): FlowletHandlerOptions {
  return { principal: async () => (userId ? { userId } : null) };
}

function endpointSuite(makeRegistry: () => FlowletRegistry | Promise<FlowletRegistry>) {
  return async () => {
    const registry = await makeRegistry();

    const saved = await handleFlowletsPost(
      req("/api/flowlet/flowlets", { method: "POST", body: JSON.stringify(draft("f1", "first")) }),
      "flowlets",
      { registry, options: options("u1") },
    );
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as Flowlet;
    expect(savedBody.id).toBe("f1");
    expect(typeof savedBody.createdAt).toBe("number");
    expect(typeof savedBody.updatedAt).toBe("number");

    const list = await handleFlowletsGet(req("/api/flowlet/flowlets"), "flowlets", {
      registry,
      options: options("u1"),
    });
    expect((await list.json()) as Flowlet[]).toEqual([savedBody]);

    const one = await handleFlowletsGet(req("/api/flowlet/flowlets/f1"), "flowlets/f1", {
      registry,
      options: options("u1"),
    });
    expect(await one.json()).toEqual(savedBody);

    const missing = await handleFlowletsGet(req("/api/flowlet/flowlets/nope"), "flowlets/nope", {
      registry,
      options: options("u1"),
    });
    expect(missing.status).toBe(404);

    // Principal isolation: a different subject sees nothing.
    const otherList = await handleFlowletsGet(req("/api/flowlet/flowlets"), "flowlets", {
      registry,
      options: options("u2"),
    });
    expect(await otherList.json()).toEqual([]);

    // Re-save preserves createdAt, bumps updatedAt.
    const resaved = await handleFlowletsPost(
      req("/api/flowlet/flowlets", {
        method: "POST",
        body: JSON.stringify({ ...draft("f1", "renamed"), updatedAt: savedBody.updatedAt + 1000 }),
      }),
      "flowlets",
      { registry, options: options("u1") },
    );
    const resavedBody = (await resaved.json()) as Flowlet;
    expect(resavedBody.name).toBe("renamed");
    expect(resavedBody.createdAt).toBe(savedBody.createdAt);
    expect(resavedBody.updatedAt).toBe(savedBody.updatedAt + 1000);

    const del = await handleFlowletsPost(req("/api/flowlet/flowlets/f1/delete", { method: "POST" }), "flowlets/f1/delete", {
      registry,
      options: options("u1"),
    });
    expect(del.status).toBe(200);
    const gone = await handleFlowletsGet(req("/api/flowlet/flowlets/f1"), "flowlets/f1", {
      registry,
      options: options("u1"),
    });
    expect(gone.status).toBe(404);

    // No principal → 403, never a bare list.
    const anon = await handleFlowletsGet(req("/api/flowlet/flowlets"), "flowlets", {
      registry,
      options: options(null),
    });
    expect(anon.status).toBe(403);

    // Percent-encoded ids: the client encodeURIComponent()s path ids, the
    // server must decode — an id with a space round-trips load AND delete.
    const spacedId = "f 2";
    const encoded = encodeURIComponent(spacedId);
    await handleFlowletsPost(
      req("/api/flowlet/flowlets", { method: "POST", body: JSON.stringify(draft(spacedId, "spaced")) }),
      "flowlets",
      { registry, options: options("u1") },
    );
    const spacedLoad = await handleFlowletsGet(
      req(`/api/flowlet/flowlets/${encoded}`),
      `flowlets/${encoded}`,
      { registry, options: options("u1") },
    );
    expect(spacedLoad.status).toBe(200);
    expect(((await spacedLoad.json()) as Flowlet).id).toBe(spacedId);
    const spacedDelete = await handleFlowletsPost(
      req(`/api/flowlet/flowlets/${encoded}/delete`, { method: "POST" }),
      `flowlets/${encoded}/delete`,
      { registry, options: options("u1") },
    );
    expect(spacedDelete.status).toBe(200);
    const spacedGone = await handleFlowletsGet(
      req(`/api/flowlet/flowlets/${encoded}`),
      `flowlets/${encoded}`,
      { registry, options: options("u1") },
    );
    expect(spacedGone.status).toBe(404);
  };
}

describe("flowlets endpoints — in-memory registry", () => {
  it("saves, lists, loads, deletes, and scopes by principal", endpointSuite(() => createInMemoryFlowletRegistry()));
});

describe("flowlets endpoints — reserved-id rejection (review blocker)", () => {
  it.each(["chat", "action", "integrations", "capabilities", "tick", "webhooks", "threads", "flowlets"])(
    "rejects a save whose id equals the reserved segment %s",
    async (id) => {
      const registry = createInMemoryFlowletRegistry();
      const res = await handleFlowletsPost(
        req("/api/flowlet/flowlets", { method: "POST", body: JSON.stringify(draft(id, "bad")) }),
        "flowlets",
        { registry, options: options("u1") },
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/reserved/i);
      expect(await registry.list({ tenantId: "flowlet-embedded", subject: "u1" })).toEqual([]);
    },
  );

  it("rejects a save whose id contains a slash", async () => {
    const registry = createInMemoryFlowletRegistry();
    const res = await handleFlowletsPost(
      req("/api/flowlet/flowlets", { method: "POST", body: JSON.stringify(draft("a/b", "bad")) }),
      "flowlets",
      { registry, options: options("u1") },
    );
    expect(res.status).toBe(400);
  });
});

describe("flowlets endpoints — Drizzle registry", () => {
  it(
    "saves, lists, loads, deletes, and scopes by principal (durable)",
    endpointSuite(async () => {
      const handle = await createFlowletDatabase({
        pglite: { dataDir: `memory://flowlet-next-flowlets-${Date.now()}-${Math.random()}` },
      });
      await migrateFlowletDatabase(handle);
      return createDrizzleFlowletRegistry(handle);
    }),
  );

  it("orders list() by updatedAt descending and survives a fresh registry over the same handle", async () => {
    const handle = await createFlowletDatabase({
      pglite: { dataDir: `memory://flowlet-next-flowlets-order-${Date.now()}` },
    });
    await migrateFlowletDatabase(handle);
    const registry = createDrizzleFlowletRegistry(handle);
    await registry.save(scope, { ...draft("a", "a"), updatedAt: 1 });
    await registry.save(scope, { ...draft("b", "b"), updatedAt: 2 });
    await registry.save(scope, { ...draft("c", "c"), updatedAt: 3 });
    await registry.save(other, { ...draft("z", "z"), updatedAt: 99 });

    const rebuilt = createDrizzleFlowletRegistry(handle);
    const list = await rebuilt.list(scope);
    expect(list.map((f) => f.id)).toEqual(["c", "b", "a"]);
  });
});
