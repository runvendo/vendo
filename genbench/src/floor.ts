import type { Fired, Path, Probed } from "./probe.js";
import type { CaseTag, World } from "./world.js";

export interface Binding {
  /** The control that was pressed. */
  readonly where: string;
  /** What pressing it did. `tool` — it asked the host for something. `state` — it
   *  asked for nothing and the screen moved anyway, which is every legitimate
   *  local control: opening a dialog, switching a tab, dismissing a row.
   *  `already-active` — it was already the one showing, so asking for nothing and
   *  moving nothing is what it is supposed to do. `choice-dropped` — it is a chooser
   *  that never took the harness's value (`choose` in `probe.ts`), so the question
   *  was never put to it. `none` — it asked for nothing and nothing happened with
   *  somewhere to go, which is a dead control. */
  readonly effect: "tool" | "state" | "already-active" | "choice-dropped" | "none";
  /** Absent when the press fired nothing at all. */
  readonly tool?: string;
  /** Only asked of a press that fired a tool: a state-only control names no tool,
   *  so there is nothing to recognise and no arguments to validate. */
  readonly known?: boolean;
  readonly argsValid?: boolean;
  readonly why?: string;
}

export interface WiredActionsResult {
  readonly pass: boolean;
  /** How many controls the probe found and pressed. A screen with nothing to
   *  press passes with 0, and 0 still passes: this is what tells that vacuous
   *  pass apart from a screen whose controls were all live. Not
   *  `bindings.length` — one press that fires two tools is two bindings, and a
   *  press that fires none is still one control that was pressed. */
  readonly pressed: number;
  readonly bindings: readonly Binding[];
  /** What cleared an `action` case's bar, and which of the three did it: a press
   *  that asked the host for something, a confirmation that WORKS — one whose own
   *  controls were pressed and found to both act and decline — or a control the
   *  press REVEALED that wrote (2026-08-18), which is the same evidence one step
   *  inside a second step the page shows inline instead of in a dialog. Absent when
   *  none of them happened. */
  readonly acted?: "tool" | "confirmation" | "revealed";
  /** Why the check failed for a reason no single binding carries — an `action`
   *  case none of whose presses did either. */
  readonly why?: string;
}

export interface FloorResult {
  readonly delivered: boolean;
  readonly renders: boolean;
  readonly valid: boolean;
  /** Why `valid` is false, in the product's own words. */
  readonly blocking: readonly string[];
  readonly wiredActions: WiredActionsResult;
  readonly pass: boolean;
}

// -------------------------------------------------------------- wired actions

/** The derived input schemas are all `{type:"object", properties, required,
 *  additionalProperties:false}`, so validating them takes five rules, not a
 *  schema library. */
function checkArgs(args: unknown, schema: Record<string, unknown>): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "arguments are not an object";
  const properties = (schema.properties ?? {}) as Record<string, { type?: string }>;
  const required = (schema.required ?? []) as string[];
  const given = args as Record<string, unknown>;
  for (const name of required) {
    if (!Object.hasOwn(given, name)) return `missing required argument "${name}"`;
    // The same failure one step on: the slot is there and there is nothing in it.
    // `move_issue({issue_id:"CAI-142", status:""})` was stamped `argsValid: true`
    // on 2026-08-18 — a status control that carried no status — so the judge
    // failed the line ("the Done segment called move_issue with status:\"\"") while
    // the floor cleared the screen and even let it prove its `action` case. Read
    // off the SCHEMA and not off the value: the tool declares this argument
    // required, and every `takes` key is (`inputSchemaFrom` in `world.ts`), so a
    // required argument sent empty is one the screen did not supply.
    if (given[name] === "") return `required argument "${name}" is empty`;
  }
  for (const [name, value] of Object.entries(given)) {
    const expected = properties[name]?.type;
    if (expected === undefined) return `unknown argument "${name}"`;
    if (typeof value !== expected) return `argument "${name}" should be a ${expected}`;
  }
  return undefined;
}

/**
 * What a live control looks like — written once, because the report spells the
 * same verdict beside every binding it prints.
 *
 * A press holds three ways. It asked the host for something the world declares,
 * with arguments that world would accept. Or it asked for nothing and the screen
 * moved anyway: an interactive screen legitimately has controls that only change
 * local state, and grading "it called nothing" as dead would fail a screen for
 * having a dialog, a tab or a dismiss button on it. Or the control was ALREADY the
 * active one (2026-08-18) — the tab the screen opens on, the radio already picked
 * — where calling nothing and moving nothing is the correct behaviour and the
 * screens that had it right were the ones convicted for it.
 *
 * Or the press never happened: a chooser that would not take the harness's value
 * (2026-08-18) was never asked the question, and reading its silence as an answer
 * convicted a correctly wired screen of a dead control — the only floor failure in
 * the 2026-08-18T21-39-10 sweep.
 *
 * Only a press that asked for nothing AND changed nothing AND had somewhere to go
 * is a dead control.
 */
export const holds = (binding: Binding): boolean =>
  binding.effect === "state"
  || binding.effect === "already-active"
  || binding.effect === "choice-dropped"
  || (binding.known === true && binding.argsValid === true);

/**
 * Whether one press asked the host to CHANGE something — a tool the world
 * declares with no canned answer (`riskOf` in `world.ts`), called with arguments
 * that tool would accept.
 *
 * A confirmation is graded on writes rather than on tool calls of any kind
 * because a real screen's decline is not silent: half the dialogs in the saved
 * corpus close by re-reading the list they came from, so "the path that calls
 * nothing" would convict a working "Keep request" for refreshing, and "the path
 * that calls anything" would let that same refresh stand in as the confirm on a
 * dialog whose confirm is dead. Both misreadings are in one saved run, in
 * opposite directions.
 */
const wrote = (calls: readonly Fired[], world: World): boolean =>
  calls.some((call) => {
    const tool = world.tools.find((known) => known.name === call.name);
    return (
      tool !== undefined
      && tool.descriptor.risk === "write"
      && checkArgs(call.args, tool.descriptor.inputSchema as Record<string, unknown>) === undefined
    );
  });

/**
 * Whether a confirmation CONFIRMS (2026-08-17). The reason it does NOT, or
 * `undefined` when it holds.
 *
 * Opening a dialog used to be the whole bar, because the probe stopped at one —
 * so a confirmation wired to nothing at all cleared an `action` case, and a
 * rubric line like "pressing approve fires approve_refund" could never be
 * evidenced for an action that lives behind one. The probe presses every control
 * inside the dialog now, one per fresh page, so the bar is what those presses
 * show: one path that goes THROUGH — a write the world declares, with arguments
 * it would accept — and one path that does not write, which is what declining
 * is. A dialog whose every button writes is as broken as one where none does: a
 * confirmation with no way to decline is not a confirmation.
 *
 * Which path is the one labelled "Confirm" is never decided here: "Cancel" in a
 * dialog about cancelling means the opposite of "Cancel" beside it. This counts;
 * the judge reads the words.
 */
function checkConfirmation(paths: readonly Path[] | undefined, world: World): string | undefined {
  // `undefined` is a trace recorded before the probe went inside; empty is a
  // dialog with nothing pressable in it. Neither is evidence that anything
  // behind the dialog works, and absent evidence has never been a pass here.
  if (paths === undefined || paths.length === 0) return "nothing inside its confirmation could be pressed";
  // One control is the whole dialog: there is no second path to decline with, so
  // it is judged by what that one control does and by nothing else.
  if (paths.length === 1) {
    return wrote(paths[0]!.calls, world)
      ? undefined
      : `its confirmation has one control, "${paths[0]!.label}", and pressing it asked the host to change nothing`;
  }
  if (!paths.some((path) => wrote(path.calls, world))) {
    return "nothing inside its confirmation asked the host to change anything";
  }
  if (!paths.some((path) => !wrote(path.calls, world))) {
    return "every control inside its confirmation writes — there is no way to decline";
  }
  return undefined;
}

/** What the probe actually saw fire, graded against the world. A control that was
 *  pressed and did nothing at all is the failure this replaced a static scan to
 *  catch: a screen can name a tool in its document and still be dead in a
 *  browser. A DISPLAY screen with nothing to press passes vacuously; an `action`
 *  case does not, because a case that asked the screen to do something is proven
 *  by a tool call — or by a confirmation that WORKS, which is now a thing the
 *  trace can answer (`checkConfirmation` above) rather than something the probe
 *  had to take on trust because it stopped at the dialog's edge. */
export function wiredActions(
  trace: readonly Probed[],
  world: World,
  tags: readonly CaseTag[] = [],
): WiredActionsResult {
  const bindings = trace.flatMap((candidate): Binding[] => {
    if (candidate.calls.length === 0) {
      return [
        candidate.dialog !== undefined
          ? { where: candidate.label, effect: "state", why: "opened a confirmation — each control inside it was pressed on a fresh page" }
          : candidate.changed
            ? { where: candidate.label, effect: "state", why: "changed the screen without calling a tool" }
            : candidate.alreadyActive === true
              ? { where: candidate.label, effect: "already-active", why: "already-active — a no-op by design" }
              : candidate.choiceDropped === true
                ? { where: candidate.label, effect: "choice-dropped", why: "the chooser never took the harness's value, so it was never put to the question" }
                : { where: candidate.label, effect: "none", why: "pressing it called nothing and changed nothing" },
      ];
    }
    return candidate.calls.map((call): Binding => {
      const tool = world.tools.find((known) => known.name === call.name);
      if (tool === undefined) {
        return { where: candidate.label, effect: "tool", tool: call.name, known: false, argsValid: false, why: `no tool named "${call.name}"` };
      }
      const why = checkArgs(call.args, tool.descriptor.inputSchema as Record<string, unknown>);
      return {
        where: candidate.label,
        effect: "tool",
        tool: call.name,
        known: true,
        argsValid: why === undefined,
        ...(why === undefined ? {} : { why }),
      };
    });
  });
  // Why each confirmation on the screen is not a working one — `undefined` where
  // it is. Read once, because the verdict and the sentence that explains it must
  // be the same reading.
  const confirmations = trace
    .filter((candidate) => candidate.dialog !== undefined)
    .map((candidate) => checkConfirmation(candidate.inside, world));
  // A write one press inside an inline reveal is the action, proven (2026-08-18):
  // "press Hand off, pick an assignee, press Confirm" is one flow, and the probe
  // used to stop at the first press of it. The flow's last step is often a
  // confirmation, so a write inside a dialog a revealed press OPENED counts the
  // same way — the probe walks that dialog now, and stopping at its edge is the
  // same missing press one turn further along. Nothing else about the reveal is
  // graded — its paths are not bindings, so a revealed control that did nothing
  // costs the screen nothing. Walking further can only ever prove more.
  const acted = bindings.some((binding) => binding.effect === "tool" && holds(binding))
    ? "tool"
    : confirmations.some((broken) => broken === undefined)
      ? "confirmation"
      : trace.some((candidate) =>
            (candidate.revealed ?? []).some(
              (path) => wrote(path.calls, world) || (path.inside ?? []).some((deeper) => wrote(deeper.calls, world)),
            ),
          )
        ? "revealed"
        : undefined;
  const why = !tags.includes("action") || acted !== undefined
    ? undefined
    : confirmations.length === 0
      ? "this case asks the screen to DO something, and no press ever asked the host for anything or opened a confirmation"
      : `this case asks the screen to DO something, and ${confirmations[0]}`;
  return {
    pass: why === undefined && bindings.every(holds),
    pressed: trace.length,
    bindings,
    ...(acted === undefined ? {} : { acted }),
    ...(why === undefined ? {} : { why }),
  };
}

// ---------------------------------------------------------------------- floor

/**
 * The four checks in report order, each under the name the report prints. One
 * list, so a score and a column can never disagree about what was checked. Every
 * one of them is decided here, mechanically, with no model anywhere near it —
 * whether the numbers on the screen are honest is a rubric line the judge grades
 * against the tool data now (`HONESTY_LINE` in `judge.ts`).
 *
 * A pass is not always a pass. A check with nothing in front of it is VACUOUS —
 * a screen with nothing to press — and it was neither earned nor missed, so it
 * stays out of any total: summing bare booleans is how a blank page came to
 * score full marks in the only aggregate this benchmark has.
 */
export interface Check {
  /** The name the report prints, on the page and in `summary.json` alike. */
  readonly name: string;
  readonly pass: boolean;
  readonly vacuous?: true;
  readonly degraded?: true;
}

/** The three every screen is put to, whatever it was asked for — written once,
 *  because the total and the per-check readout below must be two readings of the
 *  same cells and not two lists that agree by hand. */
const screenChecks = (floor: FloorResult): readonly Check[] => [
  { name: "delivered", pass: floor.delivered },
  { name: "renders", pass: floor.renders },
  { name: "valid", pass: floor.valid },
];

export const checks = (floor: FloorResult): readonly Check[] => [
  ...screenChecks(floor),
  {
    name: "wiredActions",
    pass: floor.wiredActions.pass,
    ...(floor.wiredActions.pass && floor.wiredActions.pressed === 0 ? { vacuous: true as const } : {}),
  },
];

/**
 * `wiredActions` as the three questions it answers at once.
 *
 * One cell held three different diseases — a screen whose buttons are dead, a
 * screen that called a tool nobody declares, and a screen asked to DO something
 * that never did — so in the run's totals a compile crash and a dead button moved
 * one number by the same amount and neither said which had happened.
 *
 * Nothing is decided here that was not decided already: `wiredActions.pass` is
 * exactly these three holding together, which `tests/floor.test.ts` pins over the
 * real grader. The split is how the score is READ, so no run recorded before it
 * compares differently after.
 */
export const wiredChecks = (actions: WiredActionsResult, asked: boolean): readonly Check[] => {
  const fired = actions.bindings.filter((binding) => binding.effect === "tool");
  return [
    // Nothing to press is the vacuous pass this check always had: a screen with
    // no controls on it was never put to the question.
    {
      name: "pressed",
      pass: actions.bindings.every((binding) => binding.effect !== "none"),
      ...(actions.pressed === 0 ? { vacuous: true as const } : {}),
    },
    // A press that only moved local state names no tool, so there is nothing to
    // recognise and no arguments to validate — the same reason `Binding` asks
    // `known` and `argsValid` of a tool press and of nothing else.
    { name: "wired", pass: fired.every(holds), ...(fired.length === 0 ? { vacuous: true as const } : {}) },
    // Only a case that ASKED the screen to act can earn or miss this one; on any
    // other it is a bar nobody set.
    { name: "actionProven", pass: actions.acted !== undefined, ...(asked ? {} : { vacuous: true as const }) },
  ];
};

/** The floor's six cells: the three every screen is put to, and `wiredActions`
 *  broken into the three it answers. One set of verdicts read at two altitudes —
 *  never two counts of the same cells, since a screen can miss two of the three
 *  at once and still be the single failed `wiredActions` it always was. */
export const splitChecks = (floor: FloorResult, asked: boolean): readonly Check[] => [
  ...screenChecks(floor),
  ...wiredChecks(floor.wiredActions, asked),
];

/** Every check has to hold. */
export const passes = (floor: Omit<FloorResult, "pass">): boolean =>
  floor.delivered && floor.renders && floor.valid && floor.wiredActions.pass;

export function runFloor(input: {
  world: World;
  artifact: string | undefined;
  /** What the product's own checks floor blocks in the delivered artifact. */
  blocking: readonly string[];
  trace: readonly Probed[];
  /** Something took up space and the browser said nothing while it did — the
   *  browser's verdict rather than the browser, so a case re-scored from its
   *  saved evidence hands over the one it already reached (`regrade` in
   *  `run.ts`) instead of painting the screen a second time to ask again. */
  renders: boolean;
  /** The case's own tags. `action` is the one that raises the bar. */
  tags?: readonly CaseTag[];
}): FloorResult {
  const delivered = input.artifact !== undefined && input.artifact.trim() !== "";
  const valid = delivered && input.blocking.length === 0;
  const actions = wiredActions(input.trace, input.world, input.tags ?? []);
  const floor = {
    delivered,
    renders: input.renders,
    valid,
    blocking: input.blocking,
    wiredActions: actions,
  };
  return { ...floor, pass: passes(floor) };
}
