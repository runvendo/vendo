/**
 * WHO gets hands. The shell is the resident brain's, so it composes for the
 * default `vendo()` and for a host-constructed one, and NOT for a harness whose
 * thinker lives on a machine.
 */
import { defineHarness } from "../src/harnesses/index.js";
import { VENDO_BASH_TOOL } from "../src/core/index.js";
import { type VendoStore } from "../src/store/index.js";
import { emptySharedStore } from "../src/store/backends.test-util.js";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";
import { vendo as vendoHarness } from "../src/harnesses/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function compose(extra: Record<string, unknown> = {}): Promise<Vendo> {
  const store: VendoStore = await emptySharedStore();
  return createVendo({
    store,
    principal: async () => ({ kind: "user", subject: "dev" }),
    ...extra,
  } as never);
}

const names = async (deployment: Vendo): Promise<string[]> =>
  (await deployment.guardedTools.descriptors()).map((descriptor) => descriptor.name);

describe("who gets hands", () => {
  it("mounts bash on a default deployment, with no keys and no config", async () => {
    expect(await names(await compose())).toContain(VENDO_BASH_TOOL);
  });

  it("mounts bash for a HOST-constructed vendo() too", async () => {
    expect(await names(await compose({ harness: vendoHarness() }))).toContain(VENDO_BASH_TOOL);
  });

  it("withholds bash from a harness that thinks somewhere else", async () => {
    const elsewhere = defineHarness({
      name: "elsewhere",
      // eslint-disable-next-line require-yield
      async *run() {},
    });

    expect(await names(await compose({ harness: elsewhere }))).not.toContain(VENDO_BASH_TOOL);
  });

  it("withholds bash when the host says shell: false", async () => {
    expect(await names(await compose({ shell: false }))).not.toContain(VENDO_BASH_TOOL);
  });
});
