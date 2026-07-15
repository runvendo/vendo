// @vitest-environment jsdom
import { VendoError } from "@vendoai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVendoClient } from "../src/index.js";
import { createWireServer } from "./wire-server.js";

describe("createVendoClient", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;

  beforeEach(async () => {
    wire = await createWireServer();
  });

  afterEach(async () => {
    await wire.close();
  });

  it("round-trips every client route with exact methods, paths, bodies, and headers", async () => {
    const client = createVendoClient({ baseUrl: wire.url, headers: { "X-Fixture": "lane-a" } });
    const userMessage = { id: "msg_user", role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] };

    const stream = await client.threads.stream({ threadId: "thr_1", message: userMessage });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();
    expect(await client.threads.list()).toHaveLength(1);
    expect((await client.threads.get("thr_1")).id).toBe("thr_1");

    expect(await client.approvals.pending()).toHaveLength(1);
    await client.approvals.decide("apr_1", { approve: true });
    expect(await client.grants.list()).toHaveLength(1);
    await client.grants.revoke("grt_1");

    expect(await client.connections.list()).toEqual([
      expect.objectContaining({ id: "ca_1", connector: "composio", toolkit: "gmail", status: "active" }),
    ]);
    expect(await client.connections.initiate({ toolkit: "gmail", callbackUrl: "https://host.test/vendo" })).toEqual({
      id: "ca_new",
      connector: "composio",
      redirectUrl: "https://connect.test/oauth/1",
    });
    expect((await client.connections.status("ca_1", "composio")).status).toBe("active");
    await client.connections.disconnect("ca_1", "composio");

    expect(await client.apps.list()).toHaveLength(2);
    const created = await client.apps.create({ prompt: "Revenue dashboard" });
    expect((await client.apps.get(created.id)).name).toBe("Revenue dashboard");
    expect((await client.apps.open("app_1")).kind).toBe("tree");
    expect(await client.apps.call("app_1", "fn:refresh", { month: "July" })).toEqual({
      status: "ok",
      output: { ref: "fn:refresh", args: { month: "July" } },
    });
    expect((await client.apps.edit("app_1", "Add totals")).app.name).toBe("Edited");
    expect(await client.apps.history("app_1")).toHaveLength(2);
    expect((await client.apps.undo("app_1")).name).toBe("Undone");
    expect(await client.apps.exportApp("app_1")).toEqual(new Uint8Array([0, 1, 255]));
    const imported = await client.apps.importApp(new Uint8Array([4, 5, 6]));
    expect(imported.id).toBe("app_imported");
    expect((await client.apps.fork("app_1")).forkedFrom).toBe("app_1");
    await client.apps.delete(created.id);

    expect(await client.automations.list()).toHaveLength(1);
    expect(await client.automations.enable("app_auto")).toMatchObject({ enabled: true });
    await client.automations.disable("app_auto");
    expect((await client.automations.dryRun("app_auto")).steps).toHaveLength(1);

    expect(await client.runs.list({ appId: "app_auto", status: "running", cursor: "cursor_1" })).toEqual({
      runs: [expect.objectContaining({ id: "run_1" })],
    });
    expect((await client.runs.get("run_1")).status).toBe("running");
    await client.runs.stop("run_1");
    expect(await client.activity.list({ cursor: "aud_2", limit: 10 })).toHaveLength(2);
    expect((await client.status()).posture).toBe("rules");
    await client.threads.delete("thr_1");

    const exact = (method: string, path: string, body: unknown) =>
      expect(wire.requests).toContainEqual(expect.objectContaining({ method, path, body }));
    exact("POST", "/threads", { threadId: "thr_1", message: userMessage });
    exact("GET", "/threads", undefined);
    exact("GET", "/threads/thr_1", undefined);
    exact("DELETE", "/threads/thr_1", {});
    exact("GET", "/approvals", undefined);
    exact("POST", "/approvals/decide", { ids: ["apr_1"], decision: { approve: true } });
    exact("GET", "/grants", undefined);
    exact("GET", "/connections", undefined);
    exact("POST", "/connections/initiate", { toolkit: "gmail", callbackUrl: "https://host.test/vendo" });
    exact("GET", "/connections/ca_1?connector=composio", undefined);
    exact("DELETE", "/connections/ca_1?connector=composio", {});
    exact("DELETE", "/grants/grt_1", {});
    exact("GET", "/apps", undefined);
    exact("POST", "/apps", { prompt: "Revenue dashboard" });
    exact("GET", `/apps/${created.id}`, undefined);
    exact("DELETE", `/apps/${created.id}`, {});
    exact("GET", "/apps/app_1/open", undefined);
    exact("POST", "/apps/app_1/call", { ref: "fn:refresh", args: { month: "July" } });
    exact("POST", "/apps/app_1/edit", { instruction: "Add totals" });
    exact("GET", "/apps/app_1/history", undefined);
    exact("POST", "/apps/app_1/history", { op: "undo" });
    exact("GET", "/apps/app_1/export", undefined);
    exact("POST", "/apps/import", [4, 5, 6]);
    exact("POST", "/apps/app_1/fork", {});
    exact("GET", "/automations", undefined);
    exact("POST", "/automations/app_auto/enable", {});
    exact("POST", "/automations/app_auto/disable", {});
    exact("POST", "/automations/app_auto/dry-run", {});
    exact("GET", "/runs?appId=app_auto&status=running&cursor=cursor_1", undefined);
    exact("GET", "/runs/run_1", undefined);
    exact("POST", "/runs/run_1/stop", {});
    exact("GET", "/activity?cursor=aud_2&limit=10", undefined);
    exact("GET", "/status", undefined);

    expect(wire.state.importBytes).toEqual(new Uint8Array([4, 5, 6]));
    expect(wire.requests.find(item => item.path === "/apps/import")?.headers["content-type"]).toBe(
      "application/octet-stream",
    );
    expect(wire.requests.every(item => item.headers["x-fixture"] === "lane-a")).toBe(true);
  });

  it("maps known envelopes to VendoError and preserves unknown codes on a generic error", async () => {
    const client = createVendoClient({ baseUrl: wire.url });

    await expect(client.apps.get("app_missing")).rejects.toMatchObject({
      name: "VendoError",
      code: "not-found",
      message: "App not found",
    });
    await expect(client.apps.get("app_missing")).rejects.toBeInstanceOf(VendoError);

    wire.state.statusErrorCode = "future-code";
    await expect(client.status()).rejects.toMatchObject({ name: "Error", code: "future-code", message: "Status failed" });
  });
});
