import { describe, expect, it, vi } from "vitest";
import { runKeys } from "./keys.js";

const sink = { log() {}, error() {} };

describe("cloud keys", () => {
  it("creates a key with the console API shape", async () => {
    const fetcher = vi.fn().mockResolvedValue({ key: { plaintext: "vnd_secret" } });
    expect(await runKeys(["create", "--org", "org_1", "--name", "CI"], { output: sink, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/orgs/org_1/keys", expect.objectContaining({
      auth: "user",
      method: "POST",
      body: { name: "CI" },
    }));
  });

  it("revokes the requested key", async () => {
    const fetcher = vi.fn().mockResolvedValue({});
    expect(await runKeys(["revoke", "--org=org_1", "--id", "key/a"], { output: sink, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/orgs/org_1/keys/key%2Fa/revoke", expect.objectContaining({ method: "POST" }));
  });
});
