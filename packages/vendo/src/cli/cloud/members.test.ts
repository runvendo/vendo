import { describe, expect, it, vi } from "vitest";
import { runInvite, runMembers } from "./members.js";

const sink = { log() {}, error() {} };

describe("cloud members", () => {
  it("lists members", async () => {
    const fetcher = vi.fn().mockResolvedValue({ members: [] });
    expect(await runMembers(["--org", "org_1"], { output: sink, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/orgs/org_1/members", expect.any(Object));
  });

  it("posts member invitations", async () => {
    const fetcher = vi.fn().mockResolvedValue({ invite: { id: "invite_1" } });
    expect(await runInvite([
      "--org", "org_1", "--email", "person@example.com", "--role", "admin",
    ], { output: sink, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/orgs/org_1/invites", expect.objectContaining({
      method: "POST",
      body: { email: "person@example.com", role: "admin" },
    }));
  });
});
