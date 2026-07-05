import { afterEach, describe, expect, it, vi } from "vitest";
import type { Flowlet } from "@flowlet/shell";
import { createServerFlowletStore } from "./server-store";

const flowlet: Flowlet = {
  id: "f1",
  name: "Late-night spend",
  node: { kind: "component", id: "n1", name: "Text", props: {} } as never,
  createdAt: 1,
  updatedAt: 2,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createServerFlowletStore", () => {
  it("round-trips list/load/save/remove through the /flowlets endpoints", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/flowlets") && (!init || init.method === undefined)) {
        return new Response(JSON.stringify([flowlet]), { status: 200 });
      }
      if (url.endsWith("/flowlets/f1")) {
        return new Response(JSON.stringify(flowlet), { status: 200 });
      }
      if (url.endsWith("/flowlets") && init?.method === "POST") {
        return new Response(init.body as string, { status: 200 });
      }
      if (url.endsWith("/flowlets/f1/delete") && init?.method === "POST") {
        return new Response("{}", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = createServerFlowletStore("/api/flowlet");

    expect(await store.list()).toEqual([flowlet]);
    expect(await store.load("f1")).toEqual(flowlet);
    expect(await store.save(flowlet)).toEqual(flowlet);
    await store.remove("f1");

    expect(calls.some((c) => c.url === "/api/flowlet/flowlets/f1/delete" && c.init?.method === "POST")).toBe(
      true,
    );
  });

  it("returns null (not an error) for a 404 on load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const store = createServerFlowletStore("/api/flowlet");
    expect(await store.load("nope")).toBeNull();
  });

  it("throws on a 500 — persistence failures are loud, matching web-storage's contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const store = createServerFlowletStore("/api/flowlet");
    await expect(store.list()).rejects.toThrow(/500/);
    await expect(store.save(flowlet)).rejects.toThrow(/500/);
    await expect(store.remove("f1")).rejects.toThrow(/500/);
  });
});
