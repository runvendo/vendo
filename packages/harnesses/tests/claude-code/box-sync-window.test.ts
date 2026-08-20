/**
 * The 25 seconds the box waits, and the 25 seconds the host is allowed to keep
 * trying — one number living in two files that cannot import each other.
 *
 * `box/turn-routes.mjs` parks the model behind its own write for
 * `SYNC_ACK_WAIT_MS` and then tells it the sync failed. Past that moment the host
 * is landing a write the model has been told did not land, so the replay window
 * is the same number by necessity. The box module ships inside the machine image
 * and stays dependency-free, so it cannot export the constant — which leaves two
 * literals free to drift apart silently, each still looking right on its own page.
 * They are held together here instead.
 *
 * And the window has to bound the whole retry, not just its start: a first attempt
 * that dies at 24s used to hand the second one the adapter's full timeout, five
 * minutes of holding a hot sync open on a barrier the box released long ago.
 */
import { VendoError } from "@vendoai/core";
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { boxMachine, disposeSessionMachines, type SandboxAdapterLike } from "../../src/claude-code/box.js";

const encoder = new TextEncoder();
const CHECKOUT = [{ path: "/user/a.tsx", bytes: encoder.encode("<App/>"), readOnly: false }];

afterEach(async () => {
  vi.useRealTimers();
  await disposeSessionMachines();
});

const sourceOf = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

/** The literal a `const NAME = 25_000;` line carries, as a number. */
const constantIn = (source: string, name: string): number | undefined => {
  const found = new RegExp(`const ${name} = ([\\d_]+);`).exec(source)?.[1];
  return found === undefined ? undefined : Number(found.replaceAll("_", ""));
};

test("the host's replay window is the box's own sync-ack wait", () => {
  const host = sourceOf("../../src/claude-code/box.ts");
  const box = sourceOf("../../box/turn-routes.mjs");

  // `SYNC_ACK_WAIT_MS` is defined as `MAX_POLL_WAIT_MS`, so the alias has to hold
  // too — the coupling can drift through either name.
  expect(box).toMatch(/const SYNC_ACK_WAIT_MS = MAX_POLL_WAIT_MS;/);
  expect(constantIn(host, "WORKSPACE_RETRY_WINDOW_MS")).toBe(constantIn(box, "MAX_POLL_WAIT_MS"));
});

test("a replay does not outlive the window the box already gave up on", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let attempts = 0;
  const sandbox: SandboxAdapterLike = {
    create: async () => ({
      id: "box_hang",
      async request(req) {
        if (req.path !== "/session/workspace") {
          return { status: 200, headers: {}, body: encoder.encode(JSON.stringify({ ok: true, epoch: 0 })) };
        }
        attempts += 1;
        if (attempts === 1) {
          throw new VendoError("sandbox-unavailable", "Vendo Cloud sandbox could not be reached", {
            path: "/request",
            cause: new TypeError("fetch failed"),
          });
        }
        // The replay reaches a console that accepts the connection and then says
        // nothing — the adapter would sit here for its own five minutes.
        return await new Promise(() => { /* never answers */ });
      },
      files: { read: async () => new Uint8Array(), write: async () => undefined, list: async () => [] },
      url: async () => "https://box_hang.fake-provider.test",
      destroy: async () => undefined,
    }),
    destroy: async () => undefined,
  };

  const machine = await boxMachine({ sandbox, threadId: "thr_hang", env: {}, allowedDomains: [] });
  const materializing = machine.materialize(CHECKOUT).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(30_000);
  const thrown = await materializing;

  expect(attempts).toBe(2);
  expect((thrown as VendoError).code).toBe("sandbox-unavailable");
  expect((thrown as VendoError).message).toMatch(/sync window/);
});
