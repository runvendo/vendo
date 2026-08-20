/**
 * Which failures the workspace seam may send again — and for how long.
 *
 * The retry took `call().catch(call)`, which replays EVERYTHING: a meter refusal,
 * a rejected key, a machine the provider destroyed. Those are answers, not dropped
 * connections; asking twice gets the same one, a second later, with the first
 * error thrown away. Only a fault that carries no answer is worth repeating,
 * because whether the box applied the call is exactly what is unknown.
 *
 * And only while somebody is waiting. The box parks the model behind its own write
 * for 25s (`SYNC_ACK_WAIT_MS`) and then tells it the sync failed — so a second
 * attempt that starts after that window contradicts what the model has already
 * been told.
 */
import { VendoError } from "@vendoai/core";
import { afterEach, expect, test, vi } from "vitest";
import { boxMachine, disposeSessionMachines, type SandboxAdapterLike, type SandboxMachineLike } from "../../src/claude-code/box.js";

const encoder = new TextEncoder();
const CHECKOUT = [{ path: "/user/apps/app_1/app.tsx", bytes: new TextEncoder().encode("<App/>"), readOnly: false }];

afterEach(async () => {
  vi.useRealTimers();
  await disposeSessionMachines();
});

/** A box whose control port answers hello and then fails every workspace call
 *  with `fault`, counting the attempts. */
function boxThatFails(fault: () => unknown): { sandbox: SandboxAdapterLike; attempts: () => number } {
  let attempts = 0;
  const machine: SandboxMachineLike = {
    id: "box_faulty",
    async request(req) {
      if (req.path === "/session/workspace") {
        attempts += 1;
        throw fault();
      }
      return { status: 200, headers: {}, body: encoder.encode(JSON.stringify({ ok: true })) };
    },
    files: { read: async () => new Uint8Array(), write: async () => undefined, list: async () => [] },
    url: async () => "https://box_faulty.fake-provider.test",
    destroy: async () => undefined,
  };
  return { sandbox: { create: async () => machine, destroy: async () => undefined }, attempts: () => attempts };
}

test("a refusal the console ANSWERED is not asked again", async () => {
  const { sandbox, attempts } = boxThatFails(() =>
    new VendoError("cloud-required", "Vendo Cloud: this month's build meter is exhausted"));
  const machine = await boxMachine({ sandbox, threadId: "thr_meter", env: {}, allowedDomains: [] });

  const thrown = await machine.materialize(CHECKOUT).catch((error: unknown) => error);

  expect(attempts()).toBe(1);
  // The console's own sentence survives the seam — the wire gate shows it to the
  // user verbatim — and gains the route it died on.
  expect((thrown as VendoError).code).toBe("cloud-required");
  expect((thrown as VendoError).message).toMatch(/meter is exhausted/);
  expect((thrown as VendoError).detail).toMatchObject({ path: "/session/workspace" });
});

test("a dropped connection is asked again", async () => {
  const { sandbox, attempts } = boxThatFails(() =>
    new VendoError("sandbox-unavailable", "Vendo Cloud sandbox could not be reached", {
      path: "/request",
      cause: Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNRESET") }),
    }));
  const machine = await boxMachine({ sandbox, threadId: "thr_drop", env: {}, allowedDomains: [] });

  await machine.materialize(CHECKOUT).catch(() => undefined);

  expect(attempts()).toBe(2);
});

test("a drop nobody is waiting for any more is not asked again", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { sandbox, attempts } = boxThatFails(() => {
    // The attempt outlived the box's own sync-ack window: the model has already
    // been told this write did not land.
    vi.advanceTimersByTime(30_000);
    return new VendoError("sandbox-unavailable", "Vendo Cloud sandbox could not be reached", {
      path: "/request",
      cause: new TypeError("fetch failed"),
    });
  });
  const machine = await boxMachine({ sandbox, threadId: "thr_slow", env: {}, allowedDomains: [] });

  await machine.materialize(CHECKOUT).catch(() => undefined);

  expect(attempts()).toBe(1);
});
