/**
 * `machine: "local"` holds ONE session per thread — and must re-point it at each
 * new turn's sinks.
 *
 * The bug this file exists for, measured live 2026-08-02: the session is opened
 * on the FIRST message and reused after, so it captured that first turn's `emit`
 * closure. Turn 2's text was then delivered to turn 1's event queue, which
 * nobody was draining any more, and the user's second message came back
 * completely EMPTY. The box path never had this bug because its `emit` routes
 * through whichever message is in flight; local mode has to do the same.
 *
 * (`callTool` was the other captured closure and is gone: tools reach the host's
 * MCP door now, so there is no per-turn tool sink left to mis-point.)
 */
import { describe, expect, test } from "vitest";
import { localMachine, disposeLocalSessions } from "../../src/claude-code/local.js";
import type { ClaudeTurnEvent } from "@vendoai/apps/claude-turn";

/** A session double that captures the sinks it was OPENED with, and replays each
 *  `send()` through them — exactly what the real SDK session does. */
function sessionDouble() {
  const opens: Array<Record<string, unknown>> = [];
  /** ⚠️ TEST EDIT — every word the session was STEERED with, in order. */
  const steers: string[] = [];
  let inFlight = false;
  const factory = (input: Record<string, unknown>) => {
    opens.push(input);
    return {
      async send(prompt: string) {
        inFlight = true;
        try {
          (input["emit"] as (event: ClaudeTurnEvent) => void)({ type: "text", delta: `re: ${prompt}` });
        } finally {
          inFlight = false;
        }
      },
      // ⚠️ TEST EDIT — `steer` joined the `ClaudeSession` port. The real one
      // refuses with no turn in flight (nobody would settle the extra result);
      // the double keeps that rule, because it is the rule under test.
      steer(prompt: string) {
        if (!inFlight) return false;
        steers.push(prompt);
        return true;
      },
      async interrupt() { /* nothing to stop in a double */ },
      async end() { /* nothing to close */ },
    };
  };
  return { factory, opens, steers };
}

describe("machine: \"local\" — one session, many turns", () => {
  test("turn 2's text reaches TURN 2's emit, not the closure the session was opened with", async () => {
    const double = sessionDouble();
    const threadId = `thr_local_${Math.random().toString(36).slice(2)}`;

    const firstEvents: ClaudeTurnEvent[] = [];
    const first = await localMachine({ threadId, env: {}, openSession: double.factory as never });
    await first.send({ prompt: "one", emit: (event) => firstEvents.push(event) });
    await first.release();

    const secondEvents: ClaudeTurnEvent[] = [];
    const second = await localMachine({ threadId, env: {}, openSession: double.factory as never });
    // The session is reused — that is the point of the lane.
    expect(second.carriesSession).toBe(true);
    await second.send({ prompt: "two", emit: (event) => secondEvents.push(event) });

    expect(double.opens).toHaveLength(1);
    // THE BUG: these two went to `firstEvents` instead.
    expect(secondEvents).toEqual([{ type: "text", delta: "re: two" }]);
    expect(firstEvents).toEqual([{ type: "text", delta: "re: one" }]);

    await disposeLocalSessions();
  });

  test("a dev server on this machine is reachable at loopback (blueprint §10.2)", async () => {
    // The seam has to answer on BOTH legs or it is not a seam: a box points at
    // the provider's per-port ingress, a local machine at the loopback address
    // the browser and the dev server already share.
    const machine = await localMachine({
      threadId: `thr_local_${Math.random().toString(36).slice(2)}`,
      env: {},
      openSession: sessionDouble().factory as never,
    });
    expect(await machine.url(5173)).toBe("http://127.0.0.1:5173");

    await disposeLocalSessions();
  });

  test("a steer reaches the live session with no hop, and only while a turn runs", async () => {
    // The seam's OTHER half. `SessionMachine.steer` exists in two homes — an HTTP
    // call to the box door, and this: straight into the session in this process.
    // A seam with one implementation is a seam that lies, so both are driven.
    const double = sessionDouble();
    const threadId = `thr_local_steer_${Math.random().toString(36).slice(2)}`;
    const machine = await localMachine({ threadId, env: {}, openSession: double.factory as never });

    // No session yet: nothing to steer.
    await expect(machine.steer("too early")).resolves.toBe(false);

    let steering: Promise<boolean> | undefined;
    await machine.send({
      prompt: "build me a workbench",
      // Inside the turn — the only window a steer can land in.
      emit: () => { steering ??= machine.steer("group by client instead"); },
    });

    await expect(steering).resolves.toBe(true);
    expect(double.steers).toEqual(["group by client instead"]);
    // The turn is over; the same words now belong to the next turn instead.
    await expect(machine.steer("too late")).resolves.toBe(false);

    await disposeLocalSessions();
  });
});
