import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApps } from "@vendoai/apps";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Principal,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { createStore, createStoreOps } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createByoApprovals } from "../src/byo-approvals.js";

// The parked in-app press, from park to answer. W0 made the approved call LAND
// (approve-resume.e2e.test.ts); its answer was then thrown away, so the screen
// that pressed the button sat on "waiting for approval" forever over data the
// backend had already changed.
//
// Both halves are real and neither knows about the other: the apps runtime
// writes the terminal row from its own `onApprovalDecision` subscriber, and the
// umbrella's `byoApprovals.read` — what `GET /approvals/:id` serves — reads it
// back. They agree only because they share one shape (core's ParkedCallOutcome)
// and one drawer; that agreement is what this file holds.

const principal: Principal = { kind: "user", subject: "user_parked" };
const ctx: RunContext = {
  principal,
  venue: "app",
  presence: "present",
  sessionId: "session_parked",
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A host with ONE mutating tool: it records what it delivered, and refuses the
 *  recipient nobody can reach — the two answers a resumed call can come back
 *  with. */
function messagingHost(): {
  tools: ToolRegistry;
  delivered: Array<{ clientId: string; body: string }>;
  /** Hold the next delivery INSIDE the tool. `running` settles once the resumed
   *  call is executing and `release` lets it finish — between the two is the
   *  resume window: decided, but no answer written yet. */
  holdNext(): { running: Promise<void>; release(): void };
} {
  const delivered: Array<{ clientId: string; body: string }> = [];
  let hold: { entered(): void; released: Promise<void> } | undefined;
  const descriptor: ToolDescriptor = {
    name: "host_sendClientMessage",
    description: "Message a client about their account",
    inputSchema: {
      type: "object",
      properties: { clientId: { type: "string" }, body: { type: "string" } },
      required: ["clientId", "body"],
    },
    risk: "write",
  };
  return {
    delivered,
    holdNext() {
      let entered = (): void => undefined;
      let release = (): void => undefined;
      const running = new Promise<void>(resolve => { entered = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      hold = { entered: () => entered(), released };
      return { running, release: () => release() };
    },
    tools: {
      async descriptors() {
        return [descriptor];
      },
      async execute(call) {
        if (call.tool !== "host_sendClientMessage") {
          return { status: "error", error: { code: "not-found", message: `no tool ${call.tool}` } };
        }
        const { clientId, body } = call.args as { clientId: string; body: string };
        if (clientId === "cli_closed") {
          return { status: "error", error: { code: "bank", message: "the account is closed" } };
        }
        const held = hold;
        if (held !== undefined) {
          hold = undefined;
          held.entered();
          await held.released;
        }
        delivered.push({ clientId, body });
        return { status: "ok", output: { delivered: true } };
      },
    },
  };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "vendo-parked-resolution-"));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const store = createStore({ dataDir: join(root, ".data") });
  cleanups.push(async () => store.close());
  await store.ensureSchema();
  // Every write-class call asks — the gate that parks the press in the first place.
  const guard = createGuard({ store, policy: { rules: [{ match: { risk: "write" }, action: "ask" }] } });
  const host = messagingHost();
  const tools = guard.bind(host.tools);
  // The SAME named-operation surface both sides get from the composition
  // (compose-apps passes `composition.ops` to createApps; compose-actions passes
  // it to createByoApprovals) — one deployment, one set of drawers.
  const ops = createStoreOps(store);
  const apps = createApps({ store, ops, guard, tools, catalog: [] });
  const byo = createByoApprovals({ guard, tools, ops });
  const app = await apps.importApp(
    {
      format: VENDO_APP_FORMAT,
      id: "app_seed_id_is_replaced",
      name: "Client messenger",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v2",
        root: "root",
        nodes: [{ id: "root", component: "Stack", source: "prewired" }],
      },
    } as AppDocument,
    ctx,
  );
  return { guard, apps, byo, host, appId: app.id };
}

const park = async (
  apps: Awaited<ReturnType<typeof harness>>["apps"],
  appId: string,
  clientId: string,
  body: string,
) => {
  const outcome = await apps.call(appId, "host_sendClientMessage", { clientId, body }, ctx);
  if (outcome.status !== "pending-approval") throw new Error("expected the mutation to park");
  return outcome.approvalId;
};

describe.sequential("a parked in-app press learns what happened to it", () => {
  it("reads pending, then the executed outcome once the owner approves", async () => {
    const { guard, apps, byo, host, appId } = await harness();

    const approvalId = await park(apps, appId, "cli_1", "Your documents are overdue");
    // The surface's first poll while the ask is still open: the full request, so
    // a consent card can show what is actually waiting.
    const pending = await byo.read(approvalId, principal);
    expect(pending.state).toBe("pending");
    if (pending.state !== "pending" || pending.request === undefined) throw new Error("expected a pending ask");
    expect(pending.request.call.tool).toBe("host_sendClientMessage");
    expect(host.delivered).toHaveLength(0);

    await guard.approvals.decide(approvalId, { approve: true }, principal);

    // The effect landed (W0) AND the answer survived the call that ran it, which
    // is the only way the screen can know to re-read.
    expect(host.delivered).toEqual([{ clientId: "cli_1", body: "Your documents are overdue" }]);
    await expect(byo.read(approvalId, principal)).resolves.toEqual({
      state: "executed",
      outcome: { status: "ok", output: { delivered: true } },
    });
  });

  it("carries a resumed call's FAILURE back as the executed outcome", async () => {
    const { guard, apps, byo, host, appId } = await harness();

    const approvalId = await park(apps, appId, "cli_closed", "Never lands");
    await guard.approvals.decide(approvalId, { approve: true }, principal);

    // Approved and run, and it failed. "Executed" is about the decision, not the
    // result — a blank here would tell the surface the press succeeded.
    expect(host.delivered).toHaveLength(0);
    await expect(byo.read(approvalId, principal)).resolves.toEqual({
      state: "executed",
      outcome: { status: "error", error: { code: "bank", message: "the account is closed" } },
    });
  });

  it("reports declined for a refused press, and never lands the effect", async () => {
    const { guard, apps, byo, host, appId } = await harness();

    const approvalId = await park(apps, appId, "cli_2", "This should never send");
    await guard.approvals.decide(approvalId, { approve: false }, principal);

    expect(host.delivered).toHaveLength(0);
    await expect(byo.read(approvalId, principal)).resolves.toEqual({ state: "declined" });
  });

  it("answers PENDING through the resume window, instead of a not-found the surface polls into", async () => {
    const { guard, apps, byo, host, appId } = await harness();

    const approvalId = await park(apps, appId, "cli_slow", "Takes a while to send");
    // UNDECIDED is not the resume window. A parked record stands the whole time
    // an approval is open, so serving its (request-less) snapshot here would
    // leave a re-presented modal — Esc, then the pending notice — on an empty
    // skeleton with nothing to decide, for as long as the ask stands. The guard
    // still holds the ask, so the guard's answer is the one that ships.
    const undecided = await byo.read(approvalId, principal);
    if (undecided.state !== "pending" || undecided.request === undefined) {
      throw new Error("an undecided approval must read back with its full request");
    }
    expect(undecided.request.call.args).toMatchObject({ clientId: "cli_slow" });

    const hold = host.holdNext();
    const decided = guard.approvals.decide(approvalId, { approve: true }, principal);
    await hold.running;

    // Mid-resume: the guard no longer lists the ask and the outcome row is not
    // written yet. The screen that pressed the button polls straight through
    // this window — every few seconds, for as long as the resumed call runs —
    // so a not-found here is a console error per tick, and the BYO embed reads
    // it as expired and stops asking. The parked record still exists, and that
    // is exactly "decided, not answered yet".
    await expect(byo.read(approvalId, principal)).resolves.toEqual({ state: "pending" });

    hold.release();
    await decided;
    await expect(byo.read(approvalId, principal)).resolves.toEqual({
      state: "executed",
      outcome: { status: "ok", output: { delivered: true } },
    });
  });

  it("still refuses an id nobody ever parked", async () => {
    const { byo } = await harness();
    await expect(byo.read("apr_never_existed", principal)).rejects.toThrow(/not found/u);
  });

  it("keeps the answer to the owner alone", async () => {
    const { guard, apps, byo, appId } = await harness();

    const approvalId = await park(apps, appId, "cli_3", "Private business");
    await guard.approvals.decide(approvalId, { approve: true }, principal);
    expect((await byo.read(approvalId, principal)).state).toBe("executed");

    // Same treatment a foreign id gets: an outcome row nobody else may read is
    // indistinguishable from one that never existed.
    await expect(byo.read(approvalId, { kind: "user", subject: "user_other" })).rejects.toThrow(/not found/u);
  });
});
