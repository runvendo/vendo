import { afterEach, describe, expect, it, vi } from "vitest";
import type { Vendo } from "@vendoai/shell";
import { createServerVendoStore } from "./server-store";

const vendo: Vendo = {
  id: "f1",
  name: "Late-night spend",
  node: { kind: "component", id: "n1", name: "Text", props: {} } as never,
  createdAt: 1,
  updatedAt: 2,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createServerVendoStore", () => {
  it("round-trips list/load/save/remove through the /vendos endpoints", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/vendos") && (!init || init.method === undefined)) {
        return new Response(JSON.stringify([vendo]), { status: 200 });
      }
      if (url.endsWith("/vendos/f1")) {
        return new Response(JSON.stringify(vendo), { status: 200 });
      }
      if (url.endsWith("/vendos") && init?.method === "POST") {
        return new Response(init.body as string, { status: 200 });
      }
      if (url.endsWith("/vendos/f1/delete") && init?.method === "POST") {
        return new Response("{}", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = createServerVendoStore("/api/vendo");

    expect(await store.list()).toEqual([vendo]);
    expect(await store.load("f1")).toEqual(vendo);
    expect(await store.save(vendo)).toEqual(vendo);
    await store.remove("f1");

    expect(calls.some((c) => c.url === "/api/vendo/vendos/f1/delete" && c.init?.method === "POST")).toBe(
      true,
    );
  });

  it("returns null (not an error) for a 404 on load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const store = createServerVendoStore("/api/vendo");
    expect(await store.load("nope")).toBeNull();
  });

  it("throws on a 500 — persistence failures are loud, matching web-storage's contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const store = createServerVendoStore("/api/vendo");
    await expect(store.list()).rejects.toThrow(/500/);
    await expect(store.save(vendo)).rejects.toThrow(/500/);
    await expect(store.remove("f1")).rejects.toThrow(/500/);
  });
});
