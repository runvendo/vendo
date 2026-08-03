/**
 * THE PARITY GATE — is the MCP door a drop-in replacement for the in-process
 * tool projection inside a `claudeCode()` turn?
 *
 * **cc-native measured NO (2026-08-02) and this file recorded the six ways.**
 * door-ctx closed all six, and the file is now FLIPPED: every assertion below
 * says IDENTICAL where it used to say "here is the gap". The gate is what let
 * the ask/park/answer bridge and the in-process projection be deleted, so if it
 * ever goes red again the box has quietly lost its accountability and the
 * deletion has to be reconsidered — not the assertion.
 *
 * It runs the same two tool asks — one `read` the `cautious` policy runs, one
 * `write` it parks for a human — through BOTH doors of ONE composed host (one
 * store, one guard, one policy, one registry, one subject) and compares:
 *
 *   - the AUDIT ROW: (outcome, decidedBy, presence, venue, subject)
 *   - the APPROVAL BEHAVIOR: does the guard's ask reach the USER the same way,
 *     and does a denial behave the same way?
 *   - the TRANSCRIPT MIRROR: did the user's screen and the stored thread see it?
 *
 * How the six closed, in one line each:
 *
 *   1. harness credential — the door has a second credential space (10-mcp
 *      §3b): an opaque pointer at the turn in flight, minted by the host process
 *      from inside that turn. `turn-credentials.test.ts` is what it REFUSES.
 *   2. presence — the turn's own, because the door projects `turn.ctx` verbatim.
 *   3. venue — likewise. A chat turn's door call audits `venue: "chat"`.
 *   4. approvals — the door calls `turn.tools.call()`, which is the in-process
 *      ask machinery: card on the turn's stream, wait, execute or deny.
 *   5. §12 withholding — `turn.tools.list()` is the ctx-projected, curated
 *      surface, so an unattended run is judged absent rather than told it is
 *      attended.
 *   6. mirror + commit — also `turn.tools.call()`'s, which mirrors and commits.
 *
 * The OUTSIDE-agent path is unchanged and pinned separately, in
 * `mcp-door-outside-agent.e2e.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  MOUNT,
  READ_TOOL,
  SUBJECT,
  WRITE_TOOL,
  composedHost,
  composedHostOverDoor,
  mirroredToolParts,
  rowsAddedBy,
  runCleanups,
  runHarnessTurn,
  runUnattendedTurn,
  shapeOf,
  tapWhenItAppears,
  toolRows,
} from "./mcp-door.test-util.js";

afterEach(runCleanups);

describe("parity gate — the MCP door vs the in-process projection", () => {
  it("a READ the policy runs: the two paths produce the IDENTICAL audit row and the IDENTICAL mirror", async () => {
    // LEG A — the in-process path: `turn.tools.call()` straight from a harness.
    const inHost = await composedHost(async (call) => {
      await call(READ_TOOL, { query: "balance" });
    });
    let inStream = "";
    const fromTurn = await rowsAddedBy(inHost.store, READ_TOOL, async () => {
      inStream = await runHarnessTurn(inHost.vendo, "thr_read", "look it up");
    });
    expect(inHost.observed).toEqual([`${READ_TOOL}:ok`]);
    expect(fromTurn).toHaveLength(1);

    // LEG B — a SECOND composed host, identical in every way, whose harness
    // reaches the same tool through the DOOR on a minted turn credential. This
    // is what the box does over native remote MCP, minus the network hop.
    const doorHost = await composedHostOverDoor(async (door) => {
      const answered = await door.callTool(READ_TOOL, { query: "balance" });
      expect(answered.isError).toBeFalsy();
    });
    let doorStream = "";
    const fromDoor = await rowsAddedBy(doorHost.store, READ_TOOL, async () => {
      doorStream = await runHarnessTurn(doorHost.vendo, "thr_read", "look it up");
    });
    expect(fromDoor).toHaveLength(1);

    // THE MEASUREMENT, all five contract-named fields, verbatim — and they are
    // the SAME. `venue: "chat"` on both is the one that used to differ, and it
    // is not cosmetic: venue is a policy-match field (`guard/src/policy.ts`) and
    // a grant-set predicate (`core/src/grant-sets.ts`).
    const expected = {
      outcome: "ok",
      decidedBy: "rule",
      presence: "present",
      venue: "chat",
      subject: SUBJECT,
    };
    expect(shapeOf(fromTurn[0])).toEqual(expected);
    expect(shapeOf(fromDoor[0])).toEqual(expected);
    expect(shapeOf(fromDoor[0])).toEqual(shapeOf(fromTurn[0]));

    // ...and the TRANSCRIPT saw it identically too. A tool call that reached the
    // world without appearing on the user's screen would be a hole in audit ⊇
    // transcript (wave-2 E7).
    expect(mirroredToolParts(doorStream)).toEqual(mirroredToolParts(inStream));
    expect(mirroredToolParts(doorStream)).toEqual([
      `tool-input-start:${READ_TOOL}`,
      `tool-input-available:${READ_TOOL}`,
      `tool-output-available:${READ_TOOL}`,
    ]);
  }, 30_000);

  it("a WRITE the policy parks: through the door the card reaches the USER mid-turn, the turn WAITS, and the tap executes it", async () => {
    // LEG A — in-process. One ask, one human decision, one execution.
    const inHost = await composedHost(async (call) => {
      await call(WRITE_TOOL, { amount: 1400 });
    });
    const fromTurn = await rowsAddedBy(inHost.store, WRITE_TOOL, async () => {
      const tap = tapWhenItAppears(inHost.vendo, WRITE_TOOL, true);
      await runHarnessTurn(inHost.vendo, "thr_write", "pay them");
      await tap;
    });
    expect(inHost.observed).toEqual([`${WRITE_TOOL}:ok`]);

    // LEG B — through the door. What used to happen here: an in-band "approval
    // <id> is waiting in the product's queue — resolve it there, then retry",
    // which a boxed agent cannot act on, and a `pending-approval` row recording
    // a still-live ask instead of a completed write. Now the SAME card reaches
    // the same approvals queue, the same tap answers it, and the call runs.
    const doorHost = await composedHostOverDoor(async (door) => {
      const answered = await door.callTool(WRITE_TOOL, { amount: 1400 });
      expect(answered.isError).toBeFalsy();
    });
    const fromDoor = await rowsAddedBy(doorHost.store, WRITE_TOOL, async () => {
      const tap = tapWhenItAppears(doorHost.vendo, WRITE_TOOL, true);
      await runHarnessTurn(doorHost.vendo, "thr_write", "pay them");
      await tap;
    });

    expect(shapeOf(fromDoor.at(-1))).toEqual(shapeOf(fromTurn.at(-1)));
    // `decidedBy: "grant"` on both, not `"rule"`: a human tapped, so the guard
    // records the grant that tap created. Measured — the cc-native gate only
    // asserted the in-process `outcome` here and so never saw this field.
    expect(shapeOf(fromDoor.at(-1))).toEqual({
      outcome: "ok",
      decidedBy: "grant",
      presence: "present",
      venue: "chat",
      subject: SUBJECT,
    });
  }, 40_000);

  it("a DENIED write: both paths hand the model a plain denial it can narrate, and NEITHER leaves an executed row", async () => {
    const inHost = await composedHost(async (call) => {
      await call(WRITE_TOOL, { amount: 9 });
    });
    const inTap = tapWhenItAppears(inHost.vendo, WRITE_TOOL, false);
    await runHarnessTurn(inHost.vendo, "thr_deny", "pay them");
    await inTap;
    // The turn saw a plain denial — never a throw (contract §1.1).
    expect(inHost.observed).toEqual([`${WRITE_TOOL}:denied`]);
    expect((await toolRows(inHost.store, WRITE_TOOL)).every((row) => row.outcome !== "ok")).toBe(true);

    let doorSaid = "";
    const doorHost = await composedHostOverDoor(async (door) => {
      const answered = await door.callTool(WRITE_TOOL, { amount: 9 });
      expect(answered.isError).toBe(true);
      doorSaid = answered.text;
    });
    const doorTap = tapWhenItAppears(doorHost.vendo, WRITE_TOOL, false);
    await runHarnessTurn(doorHost.vendo, "thr_deny", "pay them");
    await doorTap;

    // The GUARD's own sentence, in-band, exactly as `turn.tools.call()` returns
    // it in process — not the door's "go somewhere else and retry".
    expect(doorSaid).toBe("You turned this down.");
    expect(doorSaid).not.toContain("retry");
    expect((await toolRows(doorHost.store, WRITE_TOOL)).every((row) => row.outcome !== "ok")).toBe(true);
  }, 40_000);

  it("the door IS reachable with a per-turn credential a harness minted — and it lists the TURN's equipped surface", async () => {
    // The inverse of the cc-native measurement: `Bearer <per-turn token>` had no
    // issuer, so it was a flat 401 and there was no internal mint to call
    // instead. There is one now, it states nothing, and it resolves to the turn.
    const listed: string[] = [];
    const host = await composedHostOverDoor(async (door) => {
      listed.push(...(await door.listTools()).map((tool) => tool.name));
    });
    await runHarnessTurn(host.vendo, "thr_mint", "what can you do");
    expect(host.observed[0]).toMatch(/^minted:vtk_/);
    expect(listed).toContain(READ_TOOL);
    expect(listed).toContain(WRITE_TOOL);
  }, 30_000);

  it("§12 — an UNATTENDED turn's door call carries `away`/`automation` into the AUDIT, identically to in process", async () => {
    // The most severe of the six. `mcpContext` hardcoded `presence: "present"`
    // and `venue: "mcp"`, so an automation reaching its tools through the door
    // would have been audited AND JUDGED as if a human were watching.
    //
    // The row read here is the `approval` ledger, not `tool-call`: THE LAW's
    // presence rule asks before every unattended call whatever the policy preset
    // says (measured — `autopilot` behaves the same, `decidedBy: "default"`), so
    // nothing executes and the approval row is where the truth is written.
    const inHost = await composedHost(async (call) => {
      await call(READ_TOOL, { query: "balance" });
    });
    const fromTurn = await rowsAddedBy(inHost.store, READ_TOOL, async () => {
      await runUnattendedTurn(inHost.vendo, "thr_absent", "look it up");
    }, "approval");

    const doorHost = await composedHostOverDoor(async (door) => {
      await door.callTool(READ_TOOL, { query: "balance" });
    });
    const fromDoor = await rowsAddedBy(doorHost.store, READ_TOOL, async () => {
      await runUnattendedTurn(doorHost.vendo, "thr_absent", "look it up");
    }, "approval");

    expect(shapeOf(fromDoor.at(-1))).toEqual(shapeOf(fromTurn.at(-1)));
    expect(shapeOf(fromDoor.at(-1))).toEqual({
      outcome: "pending-approval",
      decidedBy: "default",
      presence: "away",
      venue: "automation",
      subject: SUBJECT,
    });
  }, 30_000);

  it("§1.4 — an unattended door call that needs a tap gets the ABSENT ruling, word for word what the in-process path says", async () => {
    // Before door-ctx this was structurally impossible: the door told the guard
    // a human was present, so the guard would have PARKED and the door would
    // have answered "resolve it in the product, then retry" — advice a boxed
    // agent cannot act on, about a person who is not there.
    const inHost = await composedHost(async (call) => {
      await call(WRITE_TOOL, { amount: 1400 });
    });
    await runUnattendedTurn(inHost.vendo, "thr_absent", "pay them");
    expect(inHost.observed).toEqual([`${WRITE_TOOL}:denied`]);

    let said = "";
    let listed: string[] = [];
    const doorHost = await composedHostOverDoor(async (door) => {
      listed = (await door.listTools()).map((tool) => tool.name);
      const answered = await door.callTool(WRITE_TOOL, { amount: 1400 });
      expect(answered.isError).toBe(true);
      said = answered.text;
    });
    const stream = await runUnattendedTurn(doorHost.vendo, "thr_absent", "pay them");

    expect(said).toBe("This needs your approval, and nobody is here to give it.");
    expect(said).not.toContain("retry");
    // The card STANDS for "Grant & re-run" (§1.4) and the mirror shows the
    // denial — the run failed loudly on the user's own thread, not silently in a
    // box, and not with an executed row.
    expect(stream).toContain("data-vendo-approval");
    expect(mirroredToolParts(stream)).toContain(`tool-output-denied:${WRITE_TOOL}`);
    expect((await toolRows(doorHost.store, WRITE_TOOL)).every((row) => row.outcome !== "ok")).toBe(true);
    // The listing came from the turn's OWN ctx (divergence 5) — `descriptors(ctx)`
    // is where §12 withholds, and the curated loadout decides the rest.
    expect(listed).toContain(READ_TOOL);
  }, 30_000);

  it("a credential is dead the moment its turn ends — a door call between turns is a 401", async () => {
    let stolen: string | undefined;
    const host = await composedHostOverDoor(async (_door, mint) => {
      stolen = mint();
    });
    await runHarnessTurn(host.vendo, "thr_after", "hello");
    expect(stolen).toMatch(/^vtk_/);

    // The turn is over. The same credential, the same door, the same process.
    const answered = await host.vendo.handler(new Request(MOUNT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${stolen}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } },
      }),
    }));
    expect(answered.status).toBe(401);
  }, 30_000);
});
