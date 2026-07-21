import { describe, expect, it, vi } from "vitest";
import { runKeys } from "./keys.js";

const sink = { log() {}, error() {} };

describe("cloud keys", () => {
  it("creates a key with the console API shape", async () => {
    const fetcher = vi.fn().mockResolvedValue({ key: { plaintext: "vnd_secret" } });
    expect(await runKeys(["create", "--project", "proj_1", "--name", "CI"], { output: sink, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/projects/proj_1/keys", expect.objectContaining({
      auth: "user",
      method: "POST",
      body: { name: "CI" },
    }));
  });

  it("revokes the requested key", async () => {
    const fetcher = vi.fn().mockResolvedValue({});
    expect(await runKeys(["revoke", "--project=proj_1", "--id", "key/a"], { output: sink, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/projects/proj_1/keys/key%2Fa/revoke", expect.objectContaining({ method: "POST" }));
  });

  it("lists keys resolving the project through the org", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ projects: [{ id: "proj_only" }] })
      .mockResolvedValueOnce({ keys: [] });
    expect(await runKeys(["list", "--org", "org_1"], { output: sink, fetcher })).toBe(0);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/orgs/org_1/projects");
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/projects/proj_only/keys");
  });
});
