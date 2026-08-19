import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  checks,
  passes,
  splitChecks,
  wiredActions,
  wiredChecks,
  type Check,
  type FloorResult,
} from "../src/floor.js";
import type { Probed } from "../src/probe.js";
import { loadWorld, type CaseTag, type World } from "../src/world.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let world: World;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
});

/**
 * A pass is not always a pass, and the score has to know the difference.
 *
 * `checks` handed out bare booleans, and `shapeTable` added them up — so a blank
 * page, with nothing on it to press, scored full marks in the only aggregate
 * this benchmark has, while the preview beside it was already muting that cell
 * as unearned.
 */
describe("checks", () => {
  const floorWith = (over: Partial<FloorResult>): FloorResult => ({
    delivered: true,
    renders: true,
    valid: true,
    blocking: [],
    wiredActions: { pass: true, pressed: 2, bindings: [] },
    pass: true,
    ...over,
  });

  const named = (floor: FloorResult, name: string): { pass: boolean; vacuous?: true } =>
    checks(floor).find((check) => check.name === name)!;

  it("calls a screen with nothing to press vacuous, not passed", () => {
    const blank = floorWith({ wiredActions: { pass: true, pressed: 0, bindings: [] } });

    expect(named(blank, "wiredActions")).toEqual({ name: "wiredActions", pass: true, vacuous: true });
    // The three that are always in front of a screen stay plain passes.
    expect(named(blank, "renders")).toEqual({ name: "renders", pass: true });
  });

  it("calls a screen whose controls really were pressed a plain pass", () => {
    expect(named(floorWith({}), "wiredActions")).toEqual({ name: "wiredActions", pass: true });
  });

  it("holds the floor only while every one of the four does", () => {
    expect(passes(floorWith({}))).toBe(true);
    expect(passes(floorWith({ renders: false }))).toBe(false);
    expect(passes(floorWith({ wiredActions: { pass: false, pressed: 1, bindings: [] } }))).toBe(false);
  });
});

/**
 * The same verdicts, read at the altitude a person can act on.
 *
 * One `wiredActions` cell held three different diseases — a dead button, a call
 * to a tool nobody declares, and a screen asked to DO something that never did —
 * so in the run's totals a compile crash and a dead button moved one number by
 * the same amount and nothing said which had happened.
 *
 * Nothing about what passes or fails moves: these three ARE that cell, and the
 * first test here is the one that keeps them arithmetic on it.
 */
describe("splitChecks", () => {
  const floorOf = (trace: readonly Probed[], tags: readonly CaseTag[]): FloorResult => ({
    delivered: true,
    renders: true,
    valid: true,
    blocking: [],
    wiredActions: wiredActions(trace, world, tags),
    pass: true,
  });

  /** Every shape of press the grader distinguishes, as it really grades them —
   *  hand-written bindings would prove only the hand. */
  const TRACES: Readonly<Record<string, readonly Probed[]>> = {
    "a live tool call": [{ label: "Cancel", changed: false, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] }],
    "a dead control": [{ label: "Cancel", changed: false, calls: [] }],
    "a tool nobody declares": [{ label: "Wipe", changed: false, calls: [{ name: "delete_account", args: { id: "x" } }] }],
    "arguments the world would reject": [{ label: "Cancel", changed: false, calls: [{ name: "cancel_transfer", args: {} }] }],
    "a control that only moved the screen": [{ label: "Details", changed: true, calls: [] }],
    "a confirmation that works": [
      {
        label: "Cancel all",
        dialog: "Cancel 2 transfers?",
        changed: true,
        calls: [],
        inside: [
          { label: "Keep them", changed: true, calls: [] },
          { label: "Yes, cancel them", changed: true, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] },
        ],
      },
    ],
    "nothing to press": [],
  };

  /**
   * The invariant the whole split rests on: `wiredActions.pass` is exactly these
   * three holding, over every shape of press the grader knows and asked both
   * ways. Break it and a run recorded before the split stops comparing with one
   * after it, which is the one thing this change promised not to do.
   */
  it("is the same verdict as the check it splits, on every shape of press", () => {
    for (const [what, trace] of Object.entries(TRACES)) {
      for (const asked of [true, false]) {
        const actions = wiredActions(trace, world, asked ? ["action"] : ["display"]);
        const held = wiredChecks(actions, asked).every((check) => check.vacuous === true || check.pass);

        expect(held, `${what}, ${asked ? "asked to act" : "a display case"}`).toBe(actions.pass);
      }
    }
  });

  const cell = (floor: FloorResult, asked: boolean, name: string): Check =>
    splitChecks(floor, asked).find((check) => check.name === name)!;

  it("names the six cells `checks` sums, the first three unchanged", () => {
    const floor = floorOf(TRACES["a live tool call"]!, ["action"]);

    expect(splitChecks(floor, true).map((check) => check.name)).toEqual([
      "delivered",
      "renders",
      "valid",
      "pressed",
      "wired",
      "actionProven",
    ]);
    // The screen-wide three are the same objects `checks` hands out, not a second
    // opinion about them.
    expect(splitChecks(floor, true).slice(0, 3)).toEqual(checks(floor).slice(0, 3));
  });

  /** The reading the split exists for: three ways to fail `wiredActions`, and each
   *  one lands on its own cell while the other two stay clean. */
  it("puts a dead button, a bad call and an unproven action on three different cells", () => {
    const dead = floorOf(TRACES["a dead control"]!, ["action"]);
    expect(cell(dead, true, "pressed").pass).toBe(false);
    expect(cell(dead, true, "wired")).toEqual({ name: "wired", pass: true, vacuous: true });

    const unknown = floorOf(TRACES["a tool nobody declares"]!, ["action"]);
    expect(cell(unknown, true, "pressed").pass).toBe(true);
    expect(cell(unknown, true, "wired").pass).toBe(false);

    const badArgs = floorOf(TRACES["arguments the world would reject"]!, ["action"]);
    expect(cell(badArgs, true, "wired").pass).toBe(false);

    // Every press held on its own; what this screen never did is ACT.
    const moved = floorOf(TRACES["a control that only moved the screen"]!, ["action"]);
    expect(cell(moved, true, "pressed").pass).toBe(true);
    expect(cell(moved, true, "wired")).toEqual({ name: "wired", pass: true, vacuous: true });
    expect(cell(moved, true, "actionProven").pass).toBe(false);
  });

  it("counts a confirmation the probe pressed both halves of as the action proven", () => {
    const floor = floorOf(TRACES["a confirmation that works"]!, ["action"]);

    expect(cell(floor, true, "actionProven").pass).toBe(true);
    expect(floor.wiredActions.acted).toBe("confirmation");
  });

  /**
   * Vacuous stays per check, which is the whole reason the split can be read.
   * One number could only say "1 vacuous" about a screen; these say WHICH
   * question was never in front of it — and a bar nobody set must not be scored
   * for the same reason a blank page must not score full marks.
   */
  it("keeps each cell that was never in front of the screen out of its own totals", () => {
    const blank = floorOf(TRACES["nothing to press"]!, ["display"]);
    expect(cell(blank, false, "pressed")).toEqual({ name: "pressed", pass: true, vacuous: true });
    expect(cell(blank, false, "wired")).toEqual({ name: "wired", pass: true, vacuous: true });
    expect(cell(blank, false, "actionProven").vacuous).toBe(true);

    // A display case whose presses really held: two cells earned, and the bar
    // nobody set beside them rather than failed.
    const display = floorOf(TRACES["a live tool call"]!, ["display"]);
    expect(cell(display, false, "pressed")).toEqual({ name: "pressed", pass: true });
    expect(cell(display, false, "wired")).toEqual({ name: "wired", pass: true });
    expect(cell(display, false, "actionProven").vacuous).toBe(true);
  });
});

describe("wiredActions", () => {
  const pressed = (name: string, args: unknown): Probed[] => [
    { label: "Cancel", changed: false, calls: [{ name, args }] },
  ];

  it("passes a real tool called with the arguments it declares", () => {
    expect(wiredActions(pressed("cancel_transfer", { id: "tr_1" }), world).pass).toBe(true);
  });

  /**
   * The two halves of a press that asked the host for nothing.
   *
   * An interactive screen is expected to have controls that only move local
   * state — a dialog, a tab, a dismiss — so "it called nothing" is not a verdict
   * on its own. What separates a live one from a dead one is whether the screen
   * moved, and that is the only thing these two cases differ by.
   */
  it("passes a control that called nothing but visibly changed the screen", () => {
    const result = wiredActions([{ label: "Details", changed: true, calls: [] }], world);
    expect(result.pass).toBe(true);
    expect(result.bindings[0]).toEqual({
      where: "Details",
      effect: "state",
      why: "changed the screen without calling a tool",
    });
  });

  it("fails a control that called nothing and changed nothing", () => {
    const result = wiredActions([{ label: "Cancel", changed: false, calls: [] }], world);
    expect(result.pass).toBe(false);
    expect(result.bindings[0]).toEqual({
      where: "Cancel",
      effect: "none",
      why: "pressing it called nothing and changed nothing",
    });
  });

  /** A press that opened a confirmation. Opening one asks the host for nothing,
   *  so the press itself is graded as the local control it is — what the dialog
   *  is WORTH is settled by the paths inside it, and only on a case that asked
   *  the screen to act (below). */
  it("passes a press that opened a confirmation, and says the dialog was pressed into", () => {
    const result = wiredActions([{ label: "Cancel transfer", dialog: "Cancel this transfer?", changed: true, calls: [] }], world);
    expect(result.pass).toBe(true);
    expect(result.bindings[0]).toEqual({
      where: "Cancel transfer",
      effect: "state",
      why: "opened a confirmation — each control inside it was pressed on a fresh page",
    });
  });

  /** …and the control that closes one. Nothing is left visible for the probe to
   *  read, so a dismiss records no dialog and is graded like any other local
   *  control. */
  it("passes a dismiss that closes a dialog and calls nothing", () => {
    const result = wiredActions([{ label: "Keep it", changed: true, calls: [] }], world);
    expect(result.pass).toBe(true);
    expect(result.bindings[0]).toMatchObject({ effect: "state" });
  });

  /**
   * A toggle is a control like any other by the time it reaches here.
   *
   * The probe presses every SPECIES of control now, not only the button-shaped
   * ones (`SPECIES` in `src/probe.ts`), so a switch bound to a tool arrives as an
   * ordinary binding and proves an `action` case exactly as a button does — and
   * the screens whose only actuators are switches stop reaching this function as
   * an empty trace, which is what they were failing on.
   */
  it("grades a switch that fired a tool exactly like a button that fired one", () => {
    const flipped: Probed[] = [
      { label: "Approve refunds", changed: true, calls: [{ name: "set_budget", args: { category: "coffee", limit_cents: 5000 } }] },
    ];

    const result = wiredActions(flipped, world, ["action"]);
    expect(result.pass).toBe(true);
    expect(result.acted).toBe("tool");
    expect(result.pressed).toBe(1);
  });

  it("fails a tool the world does not have", () => {
    const result = wiredActions(pressed("delete_account", { id: "x" }), world);
    expect(result.pass).toBe(false);
    expect(result.bindings[0]).toMatchObject({ known: false, why: 'no tool named "delete_account"' });
  });

  it("fails a missing required argument", () => {
    const result = wiredActions(pressed("cancel_transfer", {}), world);
    expect(result.pass).toBe(false);
    expect(result.bindings[0]).toMatchObject({ known: true, argsValid: false, why: 'missing required argument "id"' });
  });

  /**
   * A required argument sent EMPTY is the same failure as one not sent at all
   * (2026-08-18).
   *
   * `move_issue({issue_id:"CAI-142", status:""})` was stamped `argsValid: true` —
   * a status control that carried no status — so the judge failed the line
   * ("the Done segment called move_issue with status:\"\"") while the floor cleared
   * the screen and let it prove its `action` case on the strength of that call.
   * Schema-driven and not a guess about the value: the tool declares the argument
   * required, so an empty slot is a slot the screen did not fill.
   */
  it("fails a required argument sent empty", () => {
    const result = wiredActions(pressed("cancel_transfer", { id: "" }), world);
    expect(result.pass).toBe(false);
    expect(result.bindings[0]).toMatchObject({ known: true, argsValid: false, why: 'required argument "id" is empty' });
  });

  it("does not let a write with an empty required argument prove an action case", () => {
    const result = wiredActions(pressed("cancel_transfer", { id: "" }), world, ["action"]);
    expect(result.acted).toBeUndefined();
    expect(result.why).toContain("no press ever asked the host for anything");
  });

  it("fails an argument the tool does not declare", () => {
    const result = wiredActions(pressed("cancel_transfer", { id: "tr_1", force: true }), world);
    expect(result.bindings[0]).toMatchObject({ argsValid: false, why: 'unknown argument "force"' });
  });

  it("fails an argument of the wrong type", () => {
    const result = wiredActions(pressed("list_transfers", { limit: "10" }), world);
    expect(result.bindings[0]).toMatchObject({ argsValid: false, why: 'argument "limit" should be a number' });
  });

  /** …and says so. A screen with no controls passes without one control having
   *  been proven live, so the count is what tells that apart from a screen whose
   *  controls all held. */
  it("passes vacuously when a screen has nothing to press, and counts nothing pressed", () => {
    expect(wiredActions([], world)).toEqual({ pass: true, pressed: 0, bindings: [] });
  });

  it("does not pass vacuously when the case was an action", () => {
    expect(wiredActions([], world, ["action"]).pass).toBe(false);
  });

  /**
   * An `action` case asks the screen to DO something, and a toggle moving is not
   * evidence that it did. Two things are: a tool call, and a confirmation that
   * WORKS — the probe presses every control inside the dialog now (2026-08-17),
   * so a confirm-gated action's call finally reaches this trace, and "it opened a
   * dialog" stopped being enough on its own.
   */
  describe("an action case", () => {
    const DETAILS: Probed[] = [{ label: "Details", changed: true, calls: [] }];
    /** The dialog a working confirmation leaves behind: one path that acts, one
     *  that declines. */
    const confirmation = (inside: Probed["inside"]): Probed[] => [
      { label: "Cancel all", dialog: "Cancel 2 transfers?", changed: true, calls: [], ...(inside === undefined ? {} : { inside }) },
    ];
    const ACTS = { label: "Yes, cancel them", changed: true, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] };
    const DECLINES = { label: "Keep them", changed: true, calls: [] };

    it("is not proven by controls that only moved the screen", () => {
      const result = wiredActions(DETAILS, world, ["action"]);
      expect(result.pass).toBe(false);
      expect(result.why).toContain("no press ever asked the host for anything");
      expect(result.acted).toBeUndefined();
      // Every binding still holds on its own — the failure is the case's, and it
      // has to say so somewhere a reader can find it.
      expect(result.bindings[0]).toMatchObject({ effect: "state" });
    });

    it("is proven by one press that called a real tool with valid arguments", () => {
      const result = wiredActions(pressed("cancel_transfer", { id: "tr_1" }), world, ["action"]);
      expect(result.pass).toBe(true);
      expect(result.why).toBeUndefined();
      expect(result.acted).toBe("tool");
    });

    it("is proven by a confirmation whose paths both act and decline", () => {
      const result = wiredActions(confirmation([DECLINES, ACTS]), world, ["action"]);
      expect(result.pass).toBe(true);
      expect(result.why).toBeUndefined();
      expect(result.acted).toBe("confirmation");
    });

    /**
     * The class of screen that used to clear this bar on the opening alone.
     *
     * Merely showing a `[role=dialog]` was the proof while the probe stopped at
     * the dialog's edge, so a confirmation wired to nothing passed — and a line
     * like "pressing approve fires approve_refund" could not be evidenced for any
     * action behind one. Both halves are now read off the paths.
     */
    it("is NOT proven by a confirmation nothing inside is wired to", () => {
      const result = wiredActions(confirmation([DECLINES, { label: "Yes, cancel them", changed: false, calls: [] }]), world, ["action"]);
      expect(result.pass).toBe(false);
      expect(result.acted).toBeUndefined();
      expect(result.why).toContain("nothing inside its confirmation asked the host to change anything");
    });

    it("is NOT proven by a confirmation with no way to decline", () => {
      const result = wiredActions(confirmation([ACTS, { ...ACTS, label: "Cancel them all" }]), world, ["action"]);
      expect(result.pass).toBe(false);
      expect(result.why).toContain("there is no way to decline");
    });

    /**
     * A decline that REFRESHES, which is what half the confirmations in the
     * saved corpus do: "Keep request" closes the dialog and re-reads the list it
     * came from. Reading is not going through with it, so this is a working
     * decline — and grading the bar on "a path that called nothing" would have
     * convicted a correct screen for refreshing.
     */
    it("counts a decline that only re-reads the list as a decline", () => {
      const refetches = { label: "Keep them", changed: true, calls: [{ name: "list_transfers", args: { limit: 5 } }] };
      expect(wiredActions(confirmation([refetches, ACTS]), world, ["action"]).acted).toBe("confirmation");
    });

    /** …and the other side of the same coin: that refresh is not the confirm.
     *  Grading the bar on "a path that called anything" would let a Cancel that
     *  re-reads the list stand in for a confirm button wired to nothing. */
    it("is NOT proven by a dead confirm beside a decline that re-reads the list", () => {
      const result = wiredActions(
        confirmation([
          { label: "Keep them", changed: true, calls: [{ name: "list_transfers", args: { limit: 5 } }] },
          { label: "Yes, cancel them", changed: false, calls: [] },
        ]),
        world,
        ["action"],
      );
      expect(result.pass).toBe(false);
      expect(result.why).toContain("asked the host to change anything");
    });

    it("is NOT proven by a call inside the confirmation the world would reject", () => {
      const result = wiredActions(confirmation([DECLINES, { ...ACTS, calls: [{ name: "cancel_transfer", args: {} }] }]), world, ["action"]);
      expect(result.pass).toBe(false);
    });

    /** One control is the whole dialog, so there is no decline to look for and
     *  nothing to compare it against: it stands or falls on what it called. */
    it("judges a one-control confirmation by that control alone, both ways", () => {
      expect(wiredActions(confirmation([ACTS]), world, ["action"]).acted).toBe("confirmation");

      const dead = wiredActions(confirmation([{ label: "OK", changed: false, calls: [] }]), world, ["action"]);
      expect(dead.pass).toBe(false);
      expect(dead.why).toContain('its confirmation has one control, "OK"');
    });

    /**
     * The same evidence one press inside a step the page shows INLINE
     * (2026-08-18).
     *
     * "Press Hand off, pick an assignee, press Confirm" is a whole action with no
     * dialog anywhere in it, and the probe walked into `[role=dialog]` and not into
     * this — so `project-tracker`'s `capacity-rebalance` and `my-issues-inbox`
     * failed this bar in the columns that had the flow right, with the write one
     * press past where the evidence stopped. A reveal is not a confirmation and is
     * not graded like one: there is no decline to look for, only whether anything
     * the press revealed really went through.
     */
    describe("an inline second step", () => {
      const step = (revealed: Probed["revealed"]): Probed[] => [
        { label: "Hand off", changed: true, calls: [], ...(revealed === undefined ? {} : { revealed }) },
      ];
      const PICKED = { label: "Pick an assignee", changed: true, calls: [] };

      it("is proven by a revealed control that wrote", () => {
        const result = wiredActions(step([PICKED, ACTS]), world, ["action"]);
        expect(result.pass).toBe(true);
        expect(result.acted).toBe("revealed");
      });

      it("is NOT proven where nothing it revealed wrote", () => {
        const result = wiredActions(step([PICKED, { label: "Confirm", changed: false, calls: [] }]), world, ["action"]);
        expect(result.pass).toBe(false);
        expect(result.acted).toBeUndefined();
      });

      /** Walking one press further can only ever prove MORE: a revealed control
       *  that did nothing is not a binding, so it cannot fail a check the screen's
       *  own controls passed. */
      it("never turns a revealed control that did nothing into a dead one", () => {
        const result = wiredActions(step([{ label: "Confirm", changed: false, calls: [] }]), world, []);
        expect(result.bindings).toEqual([
          { where: "Hand off", effect: "state", why: "changed the screen without calling a tool" },
        ]);
        expect(result.pass).toBe(true);
      });
    });

    /** A dialog nobody could press into proves nothing — and neither does a
     *  trace recorded before the probe went inside, which is why no run from
     *  before tonight compares with one after it. */
    it("is NOT proven by a confirmation with nothing pressable in it", () => {
      expect(wiredActions(confirmation([]), world, ["action"]).pass).toBe(false);
      expect(wiredActions(confirmation(undefined), world, ["action"]).why).toContain(
        "nothing inside its confirmation could be pressed",
      );
    });

    it("is not proven by a tool call that does not hold", () => {
      expect(wiredActions(pressed("cancel_transfer", {}), world, ["action"]).pass).toBe(false);
    });

    it("leaves a display case exactly where it was", () => {
      expect(wiredActions(DETAILS, world, ["display"]).pass).toBe(true);
      expect(wiredActions(DETAILS, world).pass).toBe(true);
    });
  });

  it("counts the controls the probe pressed, not the calls they made", () => {
    // One press that fires two tools is two bindings and one control; a press
    // that fires nothing is still a control that was pressed.
    const trace: Probed[] = [
      { label: "Refresh", changed: true, calls: [{ name: "list_transfers", args: { limit: 5 } }, { name: "get_spending", args: {} }] },
      { label: "Details", changed: true, calls: [] },
    ];

    expect(wiredActions(trace, world).pressed).toBe(2);
    expect(wiredActions(trace, world).bindings).toHaveLength(3);
  });
});
