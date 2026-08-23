/**
 * The generation guard spans a wire, and the two sides ship separately: the host
 * half rides `@vendoai/harnesses`, the box half is baked into the machine image.
 * A host on this version against an image that predates it FAILS OPEN by design —
 * hello reports no generation, `adopt` has nothing to disagree with, and collect's
 * check does not apply — because a box that cannot speak about its generation
 * cannot be wrong about it, and refusing every sync-back until the rebake lands
 * would be the worse failure by far.
 *
 * Which leaves an unprotected turn looking exactly like a protected one. It says
 * so instead.
 */
import { setLogger, type VendoLogEvent } from "@vendoai/core";
import { afterEach, expect, test } from "vitest";
import { boxMachine, disposeSessionMachines, type SandboxAdapterLike } from "../../src/claude-code/box.js";

const encoder = new TextEncoder();

afterEach(async () => {
  setLogger(undefined);
  await disposeSessionMachines();
});

/** A box from before the generation: it answers everything, and reports none. */
const unversionedBox = (): SandboxAdapterLike => ({
  create: async () => ({
    id: "box_old_image",
    async request(req) {
      const body = req.path === "/session/collect" ? { files: [] } : { ok: true };
      return { status: 200, headers: {}, body: encoder.encode(JSON.stringify(body)) };
    },
    files: { read: async () => new Uint8Array(), write: async () => undefined, list: async () => [] },
    url: async () => "https://box_old_image.fake-provider.test",
    destroy: async () => undefined,
  }),
  destroy: async () => undefined,
});

test("a box whose image predates the generation says so, and is still believed", async () => {
  const lines: VendoLogEvent[] = [];
  setLogger((event) => lines.push(event));

  const machine = await boxMachine({ sandbox: unversionedBox(), threadId: "thr_old", env: {}, allowedDomains: [] });
  await machine.materialize([{ path: "/user/a.tsx", bytes: encoder.encode("<App/>"), readOnly: false }]);

  expect(lines.find((line) => line.code === "harnesses.claude-code-box-no-generation")?.message)
    .toMatch(/Rebake the box image/);
  // Fails OPEN, deliberately: the read still counts, exactly as it did before the
  // guard existed. The line above is the only difference.
  expect(await machine.collect()).toEqual([]);
});
