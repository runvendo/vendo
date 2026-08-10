import {
  ASK_USER_TOOL,
  isUnattended,
  VENDO_TOOL_TITLES,
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
const DESCRIPTOR: ToolDescriptor = {
  name: ASK_USER_TOOL,
  title: VENDO_TOOL_TITLES[ASK_USER_TOOL],
  description:
    "Use this only when you are blocked on a decision that is genuinely the user's — one you "
    + "cannot resolve from their request, from the data, or from a sensible default. Reserve it for "
    + "decisions where the answer changes what you do next; never for a choice that has a "
    + "conventional default, and never for a fact you could read with another tool. Give 2-4 "
    + "genuinely distinct choices, and if you recommend one, put it first and end its label with "
    + "\"(Recommended)\". This ENDS your turn: put the question to them in your own words as your "
    + "final message, and their reply arrives as the next thing you read.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", minLength: 1 },
      choices: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 },
    },
    required: ["question", "choices"],
    additionalProperties: false,
  },
  risk: "read",
};

/** A question with one option is not a question — it is a decision already made,
 *  dressed as a card. Refusing it is worth more than recording it: the model is
 *  told the user never saw this, so re-asking or padding with a filler second
 *  choice both fail, and the only way forward is to own the single path. The
 *  refusal is not a stop (`askedUserStop` stops only on `ok`), so the turn's
 *  remaining steps survive and the work still lands. */
const SINGLE_OPTION_REASON =
  "A question with fewer than two distinct choices has no decision in it, so this one was not put "
  + "to the user. Do not ask again and do not invent a filler second choice. State the one path you "
  + "were going to offer as the approach you are taking, then carry on and finish what was asked.";

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
 * always" — so a question never spends a grant or raises a consent card. The
 * hand-written label is final.
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
        ? [...new Set(
          args.choices
            .filter((choice): choice is string => typeof choice === "string")
            .map((choice) => choice.trim())
            .filter((choice) => choice !== ""),
        )]
        : [];
      if (choices.length < 2) {
        return { status: "error", error: { code: "validation", message: SINGLE_OPTION_REASON } };
      }
      // The question is echoed back deliberately: the mirrored tool part is the
      // record, and a record carrying the question is what makes the transcript
      // and the audit row readable without a renderer.
      return {
        status: "ok",
        output: { asked: question, choices, next: NEXT_STEP },
      };
    },
  };
}
