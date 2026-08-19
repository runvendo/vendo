import { describe, expect, it, vi } from "vitest";
import { composeConfig } from "../src/compose-config.js";
import type { CreateVendoConfig } from "../src/types.js";

/** ADAPTER RULE: the host's own assertion always wins and short-circuits the
    whole directory — with it set, no client is built and Cloud is never
    called. Only a wholly unset seam lets VENDO_API_KEY default the hosted one. */

const base = (over: Partial<CreateVendoConfig> = {}): CreateVendoConfig => ({
  principal: async () => ({ kind: "user", subject: "dev" }),
  ...over,
} as CreateVendoConfig);

describe("the memberships seam's Cloud default", () => {
  it("leaves both unset with no key", () => {
    vi.stubEnv("VENDO_API_KEY", "");
    const composed = composeConfig(base());
    expect(composed.membershipsSeam).toBeUndefined();
    expect(composed.directory).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("fills the seam from the key when the host asserted nothing", () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    const composed = composeConfig(base());
    expect(composed.directory).toBeDefined();
    expect(composed.membershipsSeam).toBe(composed.directory?.memberships);
    vi.unstubAllEnvs();
  });

  it("never builds a directory when the host asserts its own memberships", () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    const memberships = async () => [{ org: "maple" }];
    // Not through `base()`: one preset or the per-seam trio, never mixed
    // (compose-config.ts:120-131), so an `auth` config carries no top-level
    // `principal`.
    const composed = composeConfig({
      auth: { principal: async () => ({ kind: "user", subject: "dev" }), memberships },
    } as CreateVendoConfig);
    expect(composed.membershipsSeam).toBe(memberships);
    expect(composed.directory).toBeUndefined();
    vi.unstubAllEnvs();
  });
});

import { composeLimits } from "../src/limits.js";
import type { VendoComposition } from "../src/compose-context.js";

const compositionOf = (over: Partial<VendoComposition>): VendoComposition =>
  ({ config: {}, ops: undefined, directory: undefined, ...over } as VendoComposition);

const fakeDirectory = { entry: async () => ({ memberships: [], limits: {} }), memberships: async () => [] };
const meter = { usage: { count: async () => 0, record: async () => {} } };

describe("composeLimits with a Cloud directory", () => {
  it("composes the Cloud default when the host set no policy", () => {
    const { limiter } = composeLimits(compositionOf({ directory: fakeDirectory, ops: meter } as Partial<VendoComposition>));
    expect(limiter).toBeDefined();
  });

  // A host who never asked for limits must not stop booting because their BYO
  // store has no meter.
  it("does not compose, and does not throw, on a meterless store", () => {
    const { limiter } = composeLimits(compositionOf({ directory: fakeDirectory } as Partial<VendoComposition>));
    expect(limiter).toBeUndefined();
  });

  // An explicit config.limits against a meterless store keeps today's refusal.
  it("still refuses an explicit policy against a meterless store", () => {
    expect(() => composeLimits(compositionOf({
      config: { limits: async () => true }, directory: fakeDirectory,
    } as Partial<VendoComposition>))).toThrow(/needs a store that can count/);
  });

  it("lets an explicit policy win over the Cloud default", async () => {
    const { limiter } = composeLimits(compositionOf({
      config: { limits: async () => ({ allow: false, message: "mine" }) },
      directory: fakeDirectory,
      ops: meter,
    } as Partial<VendoComposition>));
    const verdict = await limiter!.gate("message", {
      principal: { kind: "user", subject: "dev" }, venue: "app", presence: "present", sessionId: "s",
    });
    expect(verdict).toMatchObject({ message: "mine" });
  });
});
