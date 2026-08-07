import { PRESENCE_ONLY_TOOLS, UNATTENDED_DESTRUCTIVE_REASON, VENDO_APPS_PIN_TOOL } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/index.js";
import { createMemoryStore } from "../fixtures/memory-store.js";
import { FixtureTools, call, context, descriptor, seedGrant } from "../fixtures/tools.js";

/**
 * ADVERSARIAL sibling of `unattended-destructive.test.ts` (risk round,
 * 2026-08-06).
 *
 * `PRESENCE_ONLY_TOOLS` (core/tools.ts) says the placement pair is withheld
 * from an unattended run "exactly as [§12] withholds a destructive one".
 * §12's own doctrine is two-layered — `projectableForRun` is "the primary
 * mechanism", and "call-time enforcement still exists as defence in depth"
 * (grant-sets.ts) — and this whole file is that second layer for the
 * destructive half.
 *
 * The presence-only half only got the first layer. `guard.ts`'s choke point
 * keys on `withheldFromUnattended(descriptor)`, i.e. on the RISK, and these
 * tools are honestly graded `write` on purpose. So the projection is the
 * WHOLE law for them: anything that reaches `execute()` by name — a standing
 * automation grant, a resumed step, a model that learned the name on an
 * attended turn, a harness that calls without listing — runs.
 */
const awayCtx = () =>
  context({
    venue: "automation",
    presence: "away",
    appId: "app_1",
    trigger: { runId: "run_1", kind: "schedule" },
  });

const pinDescriptor = () =>
  descriptor("write", {
    name: VENDO_APPS_PIN_TOOL,
    description: "Put one of the user's own apps into a named slot on the page they are looking at",
  });

describe("THE LAW, presence-only half: refused at the guard, not only hidden", () => {
  it("keeps the name in the set the projection reads", () => {
    // The control: if this ever stops being true the rest of the file is moot.
    expect(PRESENCE_ONLY_TOOLS.has(VENDO_APPS_PIN_TOOL)).toBe(true);
  });

  it("is not projected into an automation run", async () => {
    const store = createMemoryStore();
    const pin = pinDescriptor();
    const list = descriptor("read", { name: "maple_invoices_list" });
    const bound = createGuard({ store }).bind(new FixtureTools([list, pin]));

    const projected = await bound.descriptors({ venue: "automation", presence: "away" });

    expect(projected.map((d) => d.name)).toEqual(["maple_invoices_list"]);
  });

  it("refuses the same call at the choke point, whatever the model was shown", async () => {
    const store = createMemoryStore();
    const pin = pinDescriptor();
    // A standing, app-bound automation grant — the same authority the
    // destructive drill above proves the law beats. Here it is not exotic: it
    // is what "Grant & re-run" leaves behind after one attended tap.
    await seedGrant(store, { descriptor: pin, appId: "app_1", source: "automation" });
    const tools = new FixtureTools([pin]);
    const bound = createGuard({ store }).bind(tools);

    const outcome = await bound.execute(
      call(pin.name, { app: "app_1", slot: "dashboard.hero" }),
      awayCtx(),
    );

    expect(outcome).toEqual({ status: "blocked", reason: UNATTENDED_DESTRUCTIVE_REASON });
    // The row was written while nobody was there, and it evicted whatever held
    // that slot — the exact harm PRESENCE_ONLY_TOOLS' own doc names.
    expect(tools.executions).toHaveLength(0);
  });

  it("still runs it for a person who is present — the rule is presence, not the tool", async () => {
    const store = createMemoryStore();
    const pin = pinDescriptor();
    await seedGrant(store, { descriptor: pin });
    const tools = new FixtureTools([pin]);
    const bound = createGuard({ store }).bind(tools);

    const outcome = await bound.execute(
      call(pin.name, { app: "app_1", slot: "dashboard.hero" }),
      context({ venue: "chat", presence: "present" }),
    );

    expect(outcome.status).toBe("ok");
    expect(tools.executions).toHaveLength(1);
  });
});
