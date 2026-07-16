import { safeErrorMessage, type ApprovalId, type Json, type Step, type ToolCall, type ToolOutcome } from "@vendoai/core";

/**
 * Pure step-walker kernel for compound tools (04-actions §6).
 *
 * Semantics deliberately mirror the automations engine's `continueSteps`
 * (packages/automations/src/engine.ts) — same if/forEach/args ordering, same
 * forEach cap and error texts, same verbatim re-issue of a parked call on
 * resume — WITHOUT the run-record/stop persistence concerns. Automations is
 * the reference implementation; parity is enforced by a shared fixture table
 * (packages/vendo/src/compound-parity.test.ts). Single-sourcing automations
 * onto this kernel is a tracked follow-up.
 *
 * The kernel performs no I/O and never imports jsonata: `evaluate` and
 * `invoke` are injected, so the caller decides both the expression language
 * and the (guarded) execution path.
 */

/** Same constant as automations' FOREACH_MAX_ITEMS — the texts must match too. */
export const STEP_FOREACH_MAX_ITEMS = 1000;

/** Where a parked walk stopped, sufficient to resume without re-running completed steps. */
export interface StepResumePoint {
  stepIndex: number;
  forEachIndex?: number;
  iterationItems?: Json[];
  iterationOutputs?: Json[];
  stepOutputs: Record<string, Json>;
  /** Re-issued VERBATIM (same id, same args) on resume so guard's single-use approval replay matches. */
  pendingCall: ToolCall;
}

export type StepWalkResult =
  | { status: "ok"; stepOutputs: Record<string, Json> }
  | { status: "halted"; outcome: ToolOutcome; step: Step }
  | { status: "parked"; approvalId: ApprovalId; resume: StepResumePoint };

export interface StepWalkOptions {
  steps: Step[];
  /** Root expression bindings — `{ args }` for compounds, `{ event }` for automations. */
  root: Record<string, Json>;
  evaluate(expression: string, context: Record<string, Json | undefined>): Promise<Json>;
  /** Every real call goes through here; the caller owns guarding. */
  invoke(call: ToolCall): Promise<ToolOutcome>;
  newCallId(): string;
  resumeFrom?: StepResumePoint;
}

interface WalkState {
  stepIndex: number;
  stepOutputs: Record<string, Json>;
  iterationItems?: Json[];
  iterationOutputs?: Json[];
  forEachIndex?: number;
}

const validationHalt = (step: Step, message: string): StepWalkResult => ({
  status: "halted",
  outcome: { status: "error", error: { code: "validation", message } },
  step,
});

/** Matches automations' validateForEachItems verbatim (message parity is load-bearing). */
const validateForEachItems = (step: Step, value: Json): Json[] => {
  if (!Array.isArray(value)) throw new Error(`step ${step.id} forEach did not produce an array`);
  if (value.length > STEP_FOREACH_MAX_ITEMS) throw new Error(`step ${step.id} forEach exceeds ${STEP_FOREACH_MAX_ITEMS} items`);
  return value;
};

export async function walkSteps(options: StepWalkOptions): Promise<StepWalkResult> {
  const { steps, root, evaluate, invoke, newCallId } = options;

  const context = (stepOutputs: Record<string, Json>, item: Json | undefined): Record<string, Json | undefined> =>
    ({ ...root, steps: stepOutputs, item });

  const stepArgs = async (step: Step, stepOutputs: Record<string, Json>, item: Json | undefined): Promise<Record<string, Json>> => {
    const evaluationContext = context(stepOutputs, item);
    const args: Record<string, Json> = {};
    for (const [key, expression] of Object.entries(step.args ?? {})) {
      args[key] = await evaluate(expression, evaluationContext);
    }
    return args;
  };

  let state: WalkState;

  if (options.resumeFrom !== undefined) {
    const resume = options.resumeFrom;
    const step = steps[resume.stepIndex];
    if (step === undefined) {
      return validationHalt({ id: "?", tool: "?" }, "parked step is missing");
    }
    // Re-issue the parked call VERBATIM (original id + args) so guard's
    // single-use approval replay matches the approved call.
    const outcome = await invoke(resume.pendingCall);
    if (outcome.status === "pending-approval") {
      return { status: "parked", approvalId: outcome.approvalId, resume };
    }
    if (outcome.status !== "ok") return { status: "halted", outcome, step };
    if (resume.iterationItems === undefined) {
      state = {
        stepIndex: resume.stepIndex + 1,
        stepOutputs: { ...resume.stepOutputs, [step.id]: outcome.output },
      };
    } else {
      state = {
        stepIndex: resume.stepIndex,
        stepOutputs: { ...resume.stepOutputs },
        iterationItems: resume.iterationItems,
        iterationOutputs: [...(resume.iterationOutputs ?? []), outcome.output],
        forEachIndex: (resume.forEachIndex ?? 0) + 1,
      };
    }
  } else {
    state = { stepIndex: 0, stepOutputs: {} };
  }

  for (let stepIndex = state.stepIndex; stepIndex < steps.length; stepIndex += 1) {
    const step = steps[stepIndex] as Step;
    let items: Json[] | undefined = stepIndex === state.stepIndex ? state.iterationItems : undefined;
    const outputs: Json[] = stepIndex === state.stepIndex ? state.iterationOutputs ?? [] : [];
    const iterationStart = stepIndex === state.stepIndex ? state.forEachIndex ?? 0 : 0;
    try {
      if (items === undefined) {
        if (step.if !== undefined && !await evaluate(step.if, context(state.stepOutputs, undefined))) {
          continue;
        }
        if (step.forEach !== undefined) {
          const evaluated = await evaluate(step.forEach, context(state.stepOutputs, undefined));
          items = validateForEachItems(step, evaluated);
        }
      }
    } catch (cause) {
      return validationHalt(step, safeErrorMessage(cause));
    }

    const iterations: Array<{ item?: Json }> = items === undefined ? [{}] : items.map((item) => ({ item }));
    for (let index = iterationStart; index < iterations.length; index += 1) {
      const iteration = iterations[index] as { item?: Json };
      let args: Record<string, Json>;
      try {
        args = await stepArgs(step, state.stepOutputs, iteration.item);
      } catch (cause) {
        return validationHalt(step, safeErrorMessage(cause));
      }
      const call: ToolCall = { id: newCallId(), tool: step.tool, args };
      const outcome = await invoke(call);
      if (outcome.status === "pending-approval") {
        return {
          status: "parked",
          approvalId: outcome.approvalId,
          resume: {
            stepIndex,
            ...(items === undefined ? {} : { forEachIndex: index, iterationItems: items, iterationOutputs: outputs }),
            stepOutputs: state.stepOutputs,
            pendingCall: call,
          },
        };
      }
      if (outcome.status !== "ok") return { status: "halted", outcome, step };
      if (items === undefined) state.stepOutputs[step.id] = outcome.output;
      else outputs.push(outcome.output);
    }
    if (items !== undefined) state.stepOutputs[step.id] = outputs;
  }

  return { status: "ok", stepOutputs: state.stepOutputs };
}
