import {
  VENDO_TOOL_TITLES,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";

/** The tool name, spelled once: the descriptor, the title table's key and the
 *  prompt paragraph all have to say the same word. */
export const UPDATE_PLAN_TOOL = "update_plan";

/**
 * The plan door — one tool for a multi-part ask, built like `ask_user`.
 *
 * A turn that was asked for three things drifts: it does the first, narrates,
 * and forgets the rest. Writing the steps down before starting is what keeps the
 * last one from being dropped, and marking each one done as it lands is what
 * makes the drift visible mid-turn instead of at the end.
 *
 * It owns no machinery and no storage. The runtime mirrors every
 * `turn.tools.call` into the transcript, so the plan and its statuses are
 * durable the moment the call returns — exactly as `ask_user` records its
 * question. A separate plan registry would be a second copy of the transcript.
 */
const DESCRIPTOR: ToolDescriptor = {
  name: UPDATE_PLAN_TOOL,
  title: VENDO_TOOL_TITLES[UPDATE_PLAN_TOOL],
  description:
    "Track a multi-part ask: write the steps down before you start, then call this again to mark each "
    + "one done as you finish it. Use it when the user asked for more than one thing in a single message. "
    + "At most one step is in_progress at a time. Never make a single-step plan, and skip it entirely for "
    + "a one-step ask. Do not repeat the plan's contents in your reply — the user already sees it.",
  inputSchema: {
    type: "object",
    properties: {
      plan: {
        type: "array",
        items: {
          type: "object",
          properties: {
            step: { type: "string", minLength: 1 },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["step", "status"],
          additionalProperties: false,
        },
      },
      explanation: { type: "string" },
    },
    required: ["plan"],
    additionalProperties: false,
  },
  risk: "read",
};

interface PlanStep {
  step: string;
  status: string;
}

const readSteps = (value: unknown): PlanStep[] =>
  (Array.isArray(value) ? value : []).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { step, status } = entry as { step?: unknown; status?: unknown };
    if (typeof step !== "string" || step.trim() === "") return [];
    return [{ step: step.trim(), status: typeof status === "string" ? status : "pending" }];
  });

/**
 * The `update_plan` door as a one-tool registry, composed alongside the others so
 * the guard, the audit trail, and `find_tools` all see it like any other tool.
 *
 * It is a `read` because planning costs no authority — §12's "reads are silent,
 * always" — so a plan never spends a grant or raises a consent card.
 *
 * The result echoes the plan back deliberately: the mirrored tool part is the
 * record, and a record carrying the step count and the step in flight is what
 * makes the transcript and the audit row readable without a renderer.
 */
export function planRegistry(): ToolRegistry {
  return {
    async descriptors() {
      return [DESCRIPTOR];
    },

    async execute(call) {
      const args = (call.args ?? {}) as { plan?: unknown };
      const steps = readSteps(args.plan);
      if (steps.length === 0) {
        return {
          status: "error",
          error: { code: "validation", message: "update_plan needs the steps of the plan" },
        };
      }
      const inProgress = steps.find((entry) => entry.status === "in_progress");
      return {
        status: "ok",
        output: {
          recorded: steps.length,
          ...(inProgress === undefined ? {} : { next: inProgress.step }),
        },
      };
    },
  };
}
