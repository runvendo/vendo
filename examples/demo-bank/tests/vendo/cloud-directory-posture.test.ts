import { afterEach, describe, expect, it, vi } from "vitest";

type VendoConfig = Parameters<typeof import("@vendoai/vendo/server").createVendo>[0];

/** What `createVendo` was actually handed. Both halves of the posture are spreads
 *  INSIDE that config literal, and the composed instance exposes no config, so the
 *  call is the only place either one can be read. `importOriginal` leaves every
 *  other export — and the real composition — alone. */
const composed = vi.hoisted(() => ({ config: undefined as VendoConfig | undefined }));

vi.mock("@vendoai/vendo/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vendoai/vendo/server")>();
  return {
    ...actual,
    createVendo: (config: VendoConfig) => {
      composed.config = config;
      return actual.createVendo(config);
    },
  };
});

/** Maple's two routes, both honest. With a Cloud key the tenant directory
 *  answers and the console's caps apply; without one Maple asserts its own
 *  orgs and its own policy, exactly as it always did. The branch is read at
 *  module load, so each case re-imports. Re-importing pays vite's transform of
 *  the whole SDK graph (~12s cold), so the hang-detector has to sit above it. */
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); composed.config = undefined; });

describe("Maple's directory posture", () => {
  it("asserts its own orgs and policy with NO Cloud key", { timeout: 60_000 }, async () => {
    vi.stubEnv("VENDO_API_KEY", "");
    vi.resetModules();
    const { mapleAuth, mapleLimits } = await import("../../src/vendo/server");
    expect(mapleAuth.memberships).toBeTypeOf("function");
    expect(composed.config?.limits).toBe(mapleLimits);
    await expect(mapleAuth.memberships!({ kind: "user", subject: "vendo-demo" }))
      .resolves.toMatchObject([{ org: "maple" }]);
  });

  // Both halves, or the case proves half a posture: restoring Maple's own limits
  // under a Cloud key leaves the console's tenant caps overridden by a host
  // callback that always wins, and a memberships-only assertion still passes.
  it("lets the directory answer WITH a Cloud key", { timeout: 60_000 }, async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    vi.resetModules();
    const { mapleAuth } = await import("../../src/vendo/server");
    expect(mapleAuth.memberships).toBeUndefined();
    expect(composed.config?.limits).toBeUndefined();
  });
});
