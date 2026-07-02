import { describe, it, expect, vi, afterEach } from "vitest";
import { runQuery } from "./run-query";

afterEach(() => vi.unstubAllGlobals());

describe("runQuery (reads-only replay seam)", () => {
  it("refuses non-allowlisted tools without touching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(runQuery({ path: "/v", tool: "set_rule", input: {} })).rejects.toThrow(/not read-only/);
    await expect(runQuery({ path: "/v", tool: "unknown_tool" })).rejects.toThrow(/not read-only/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("replays read-only tools through the policy-governed action route", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ decision: "allow", result: [{ merchant: "DoorDash" }] }),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await runQuery({ path: "/tx", tool: "get_transactions", input: { limit: 5 } });
    expect(result).toEqual([{ merchant: "DoorDash" }]);
    expect(fetchSpy).toHaveBeenCalledWith("/api/flowlet/action", expect.objectContaining({ method: "POST" }));
    const init = fetchSpy.mock.calls[0]![1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({ action: "get_transactions", payload: { limit: 5 } });
  });
});
