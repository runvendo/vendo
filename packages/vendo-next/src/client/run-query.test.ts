import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManifestTool } from "@vendoai/core";
import { createRunQuery } from "./run-query.js";

function manifestTool(overrides: Partial<ManifestTool> = {}): ManifestTool {
  return {
    name: "get_things",
    description: "read things",
    inputSchema: { type: "object", properties: {} },
    annotations: { mutating: false, dangerous: false },
    binding: { type: "http", method: "GET", path: "/api/things" },
    ...overrides,
  } as ManifestTool;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRunQuery reads-only replay guard", () => {
  it("replays a tool whose validated annotations read mutating: false", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ things: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const runQuery = createRunQuery("/api/vendo", [manifestTool()]);
    await expect(runQuery({ path: "", tool: "get_things" })).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to replay a tool annotated mutating: true", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const runQuery = createRunQuery("/api/vendo", [
      manifestTool({
        name: "cancel_thing",
        annotations: { mutating: true, dangerous: false },
        binding: { type: "http", method: "POST", path: "/api/things/cancel" },
      }),
    ]);
    await expect(runQuery({ path: "", tool: "cancel_thing" })).rejects.toThrow(/not replayable/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("FAIL CLOSED: annotations missing the `mutating` field are never replayable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Forged/unvalidated shape: `annotations: {}` reads `!undefined` = true
    // under a naive truthiness check — it must NOT count as read-only.
    const forged = {
      ...manifestTool({
        name: "cancel_thing",
        binding: { type: "http", method: "POST", path: "/api/things/cancel" },
      }),
      annotations: {},
    } as unknown as ManifestTool;

    const runQuery = createRunQuery("/api/vendo", [forged]);
    await expect(runQuery({ path: "", tool: "cancel_thing" })).rejects.toThrow(/not replayable/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("FAIL CLOSED: absent annotations are never replayable (and do not crash the seam)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { annotations: _dropped, ...rest } = manifestTool({
      name: "cancel_thing",
      binding: { type: "http", method: "POST", path: "/api/things/cancel" },
    });
    const forged = rest as unknown as ManifestTool;

    // Other (valid) tools in the same manifest must keep working.
    const runQuery = createRunQuery("/api/vendo", [forged, manifestTool()]);
    await expect(runQuery({ path: "", tool: "cancel_thing" })).rejects.toThrow(/not replayable/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("FAIL CLOSED: a non-boolean `mutating` (e.g. 0) is never replayable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const forged = {
      ...manifestTool({
        name: "cancel_thing",
        binding: { type: "http", method: "POST", path: "/api/things/cancel" },
      }),
      annotations: { mutating: 0, dangerous: false },
    } as unknown as ManifestTool;

    const runQuery = createRunQuery("/api/vendo", [forged]);
    await expect(runQuery({ path: "", tool: "cancel_thing" })).rejects.toThrow(/not replayable/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
