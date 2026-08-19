import { afterEach, describe, expect, it, vi } from "vitest";

/** Maple's two routes, both honest. With a Cloud key the tenant directory
 *  answers and the console's caps apply; without one Maple asserts its own
 *  orgs and its own policy, exactly as it always did. The branch is read at
 *  module load, so each case re-imports. Re-importing pays vite's transform of
 *  the whole SDK graph (~12s cold), so the hang-detector has to sit above it. */
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("Maple's directory posture", () => {
  it("asserts its own orgs and policy with NO Cloud key", { timeout: 60_000 }, async () => {
    vi.stubEnv("VENDO_API_KEY", "");
    vi.resetModules();
    const { mapleAuth, mapleLimits } = await import("../../src/vendo/server");
    expect(mapleAuth.memberships).toBeTypeOf("function");
    expect(mapleLimits).toBeTypeOf("function");
    await expect(mapleAuth.memberships!({ kind: "user", subject: "vendo-demo" }))
      .resolves.toMatchObject([{ org: "maple" }]);
  });

  it("lets the directory answer WITH a Cloud key", { timeout: 60_000 }, async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    vi.resetModules();
    const { mapleAuth } = await import("../../src/vendo/server");
    expect(mapleAuth.memberships).toBeUndefined();
  });
});
