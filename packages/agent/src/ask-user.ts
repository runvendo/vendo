import {
  ASK_USER_TOOL,
  isUnattended,
  VENDO_TOOL_TITLES,
  vendoAuthored,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";

export { ASK_USER_TOOL };

/**
 * Design §4 — questions are a tool, one door, any seat.
 *
 * A question is TURN-ENDING, not a blocking mid-turn card. Build contract §8 cuts
 * steering (mid-turn user input), and design §6 has the builder "ask the user
 * through the one door if genuinely ambiguous, and dies". So the door does three
 * things and owns no machinery:
 *
 *  1. **It records the question.** The runtime mirrors every `turn.tools.call`
 *     into the transcript and the guard writes its audit row, so the question and
 *     its choices are already durable the moment the call returns. A separate
 *     pending-question registry would be a second copy of the transcript.
 *  2. **It ends the turn** (`askedUserStop`, loop.ts). Carrying on without the
 *     answer is exactly the invention this tool exists to prevent.
 *  3. **The answer arrives as the next turn's message.** That is why there is no
 *     wire part, no answer door and no renderer: the reply is an ordinary user
 *     message, and the next turn reads it out of the canonical transcript like
 *     anything else.
 *
 * There is deliberately no `collect` seam. Awaiting a person INSIDE a tool call is
 * the blocking card §8 cuts: it needs a wire part core does not have (§1.6 freezes
 * stream-parts.ts), and it holds a turn — and, for a boxed harness, a machine —
 * open on a human's attention.
 */
const DESCRIPTOR: ToolDescriptor = vendoAuthored({
  name: ASK_USER_TOOL,
  title: VENDO_TOOL_TITLES[ASK_USER_TOOL],
  description:
    "Ask the user a question when you genuinely cannot proceed without something only they know — "
    + "never to confirm work you can simply do, and never to guess out loud. This ENDS your turn: "
    + "put the question to them in your own words as your final message, and their reply arrives as "
    + "the next thing you read.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", minLength: 1 },
      choices: { type: "array", items: { type: "string" } },
    },
    required: ["question"],
    additionalProperties: false,
  },
  risk: "read",
});

const UNATTENDED_REASON =
  "There is nobody here to answer a question: this run is unattended. "
  + "Finish what you can without asking, or stop and say what you needed.";

/** What the model is told to do with the question it just registered. The tool
 *  cannot speak to the user itself — only `text` reaches the screen (§1.5) — so
 *  the assistant asks in its own voice, which is also the consumer-voice-correct
 *  way for a question to arrive. */
const NEXT_STEP =
  "Recorded. Now ask the user this question in your own words as your final message, and stop. "
  + "Do not carry on working and do not assume an answer — their reply will be the next thing you read.";

/**
 * The `ask_user` door as a one-tool registry, composed alongside the others so the
 * guard, the audit trail, and `find_tools` all see it like any other tool.
 *
 * It is a `read` because asking costs no authority — §12's "reads are silent,
 * always" — so a question never spends a grant or raises a consent card. That
 * label is HAND-WRITTEN here, which is why the descriptor is marked
 * `vendoAuthored`: the second mechanical vote is for AI-assigned labels, and its
 * verb-shape heuristic (calibrated for extracted `noun_verb` names) reads the
 * trailing noun of `ask_user` and fail-closes to `write`, which would make a
 * question mutating.
 *
 * What it must never be is available with nobody present, which is enforced
 * twice: the descriptor is withheld from an unattended run, and execute refuses
 * one.
 */
export function askUserRegistry(): ToolRegistry {
  return {
    async descriptors(ctx) {
      // A question with no one to answer it is not a question.
      if (ctx !== undefined && isUnattended(ctx)) return [];
      return [DESCRIPTOR];
    },

    async execute(call, ctx: RunContext) {
      if (isUnattended(ctx)) {
        return { status: "blocked", reason: UNATTENDED_REASON };
      }
      const args = (call.args ?? {}) as { question?: unknown; choices?: unknown };
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (question === "") {
        return {
          status: "error",
          error: { code: "validation", message: "ask_user needs a question to put to the user" },
        };
      }
      const choices = Array.isArray(args.choices)
        ? args.choices.filter((choice): choice is string => typeof choice === "string")
        : undefined;
      // The question is echoed back deliberately: the mirrored tool part is the
      // record, and a record carrying the question is what makes the transcript
      // and the audit row readable without a renderer.
      return {
        status: "ok",
        output: { asked: question, ...(choices === undefined ? {} : { choices }), next: NEXT_STEP },
      };
    },
  };
}
