// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeConnection } from "../../src/chrome/connect-dock.js";
import type { VendoClient } from "../../src/index.js";

/** A minimal client whose `status` behavior is scripted per call — the loop
    under test only touches `connections.initiate` and `connections.status`. */
function clientWhoseStatus(status: () => Promise<unknown>): { client: VendoClient; status: ReturnType<typeof vi.fn> } {
  const statusMock = vi.fn(status);
  const client = {
    connections: {
      initiate: vi.fn(async () => ({ id: "con_1", connector: undefined, redirectUrl: "https://broker.example/consent" })),
      status: statusMock,
    },
  } as unknown as VendoClient;
  return { client, status: statusMock };
}

const pending = () => Promise.resolve({ status: "pending" });
const failing = () => Promise.reject(new Error("boom"));
const rateLimited = () => Promise.reject(Object.assign(new Error("try later"), { code: "unavailable" }));

describe("completeConnection failure backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin the jitter to its upper bound so every asserted delay is exact.
    vi.spyOn(Math, "random").mockReturnValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the healthy 1.5s cadence while the connection is pending", async () => {
    const { client, status } = clientWhoseStatus(pending);
    const run = completeConnection(client, { toolkit: "github" }, () => false, null);
    run.catch(() => {});

    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(status).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(status).toHaveBeenCalledTimes(3);
  });

  it("backs off exponentially on failures, floored at the healthy cadence", async () => {
    const { client, status } = clientWhoseStatus(failing);
    const run = completeConnection(client, { toolkit: "github" }, () => false, null);
    run.catch(() => {});

    // Delays after each failure: max(1500, 1000)=1500, 2000, 4000, 8000, 15000.
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(status).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(status).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(status).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(status).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(status).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(status).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(status).toHaveBeenCalledTimes(6);
  });

  it("jumps straight to the unjittered 15s cap when the wire says `unavailable`", async () => {
    // Pin the jitter to its LOWER bound: a jittered rate-limited delay would
    // fire at 7.5s and this test would catch it.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { client, status } = clientWhoseStatus(rateLimited);
    const run = completeConnection(client, { toolkit: "github" }, () => false, null);
    run.catch(() => {});

    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("actually jitters ordinary failures: the low-bound delay is half the backoff", async () => {
    // With the jitter pinned LOW, the third failure waits backoff/2 = 2s
    // instead of the full 4s. Deleting the jitter term makes this fire at 4s
    // and fail, so the thundering-herd defense is covered, not just tolerated.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { client, status } = clientWhoseStatus(failing);
    const run = completeConnection(client, { toolkit: "github" }, () => false, null);
    run.catch(() => {});

    // Delays at the low bound: max(1500, 500)=1500, max(1500, 1000)=1500, 2000.
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(status).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(status).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(status).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(status).toHaveBeenCalledTimes(4);
  });

  it("resets to the healthy cadence after a successful answer", async () => {
    let call = 0;
    const { client, status } = clientWhoseStatus(() => {
      call += 1;
      // fail, fail, pending, then fail again: the last failure is a FIRST
      // failure again, so its delay is back at the floor.
      if (call === 3) return pending();
      return failing();
    });
    const run = completeConnection(client, { toolkit: "github" }, () => false, null);
    run.catch(() => {});

    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(status).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(status).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(status).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(status).toHaveBeenCalledTimes(5);
  });

  it("still gives up at the 120s deadline with the coded timeout", async () => {
    const { client } = clientWhoseStatus(failing);
    const run = completeConnection(client, { toolkit: "github" }, () => false, null);
    const settled = run.catch((reason: unknown) => reason);

    await vi.advanceTimersByTimeAsync(121_000);
    const reason = await settled;
    expect(reason).toMatchObject({ code: "timeout" });
  });

  it("rescues a connection that went active inside the last backoff window", async () => {
    // Every in-loop poll fails; the final pre-timeout check answers active.
    // Without that last look, a connect that succeeded during the capped wait
    // is reported as "nothing changed".
    let last = false;
    const { client } = clientWhoseStatus(() => (last ? Promise.resolve({ status: "active" }) : failing()));
    const run = completeConnection(client, { toolkit: "github" }, () => false, null);
    const settled = run.then(() => "resolved", () => "rejected");

    await vi.advanceTimersByTimeAsync(119_000);
    last = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await settled).toBe("resolved");
  });

  it("honours a cancel raised during a capped backoff wait", async () => {
    let cancelled = false;
    const { client, status } = clientWhoseStatus(rateLimited);
    const run = completeConnection(client, { toolkit: "github" }, () => cancelled, null);
    run.catch(() => {});

    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(250);
    await expect(run).resolves.toBeUndefined();
    expect(status).toHaveBeenCalledTimes(1);
  });
});
