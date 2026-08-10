import {
  VENDO_TOOL_TITLES,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";

/**
 * The name of the parts ledger, `vendo_`-prefixed on purpose: that prefix is
 * what keeps a tool on every loadout (`isAlwaysActive`,
 * harnesses/src/vendo/tool-search.ts), and a planning tool the system prompt
 * teaches is worthless on the one deployment big enough to gate it away.
 */
export const VENDO_PARTS_TOOL = "vendo_parts";

/**
 * A stateless ledger of the parts of a multi-part ask.
 *
 * The measured failure it exists for: on an ask with several parts the agent
 * would work the whole thing in its head, spend a run of searches on part one,
 * and paint nothing until every part was finished — so a turn that answered late
 * and a turn that dropped a part looked identical from the outside.
 *
 * It owns no machinery, for ask-user.ts's reason: the runtime mirrors every
 * `turn.tools.call` into the transcript, so the last list the model sent IS the
 * state, already durable and already in the next call's context. A ledger store
 * would be a second copy of the transcript, and one that could disagree with it.
 * Hence the whole list every time — it REPLACES the last one, so there is
 * nothing to reconcile and no partial update to get wrong.
 *
 * The two disciplines in the description are the ones that make a list worth
 * writing rather than a preamble the model narrates and abandons: exactly one
 * part in progress, and a part marked done the moment it is done instead of in a
 * batch at the end. The third line is the guard against the tool's own failure
 * mode — a ledger on a one-line ask spends a step and buys nothing.
 */
const DESCRIPTOR: ToolDescriptor = {
  name: VENDO_PARTS_TOOL,
  title: VENDO_TOOL_TITLES[VENDO_PARTS_TOOL],
  description:
    "List the parts of an ask that has several, before you start on them, and keep the list current as you "
    + "work. Send the WHOLE list every time — it replaces the last one. Keep exactly one part \"doing\". Mark "
    + "a part \"done\" the moment it is done, never batched up at the end. Skip this tool entirely for a "
    + "single simple ask.",
  inputSchema: {
    type: "object",
    properties: {
      parts: {
        type: "array",
        minItems: 2,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["what", "status"],
          properties: {
            what: { type: "string" },
            status: { type: "string", enum: ["todo", "doing", "done"] },
          },
        },
      },
    },
    required: ["parts"],
    additionalProperties: false,
  },
  risk: "read",
};

/** What the model is told to do with the list it just wrote. The echo is the
 *  point: the mirrored tool part is the record, so the list it reads back on the
 *  next step is the one it sent. */
const NEXT_STEP =
  "Noted — this is your list now, and it replaced the last one. Get on with the part that is \"doing\" "
  + "(exactly one), send the list again the moment a part is done rather than saving them all for the end, "
  + "and do not read the list out to the user.";

/**
 * The ledger as a one-tool registry, composed alongside the others so the guard,
 * the audit trail and `find_tools` see it like any other tool.
 *
 * A `read`: writing down what you are about to do costs no authority, so it never
 * spends a grant or raises a consent card (§12 — "reads are silent, always").
 * Unattended runs keep it too — an away run has parts like any other, and it
 * touches nothing but its own transcript.
 */
export function partsRegistry(): ToolRegistry {
  return {
    async descriptors() {
      return [DESCRIPTOR];
    },

    async execute(call) {
      const args = (call.args ?? {}) as { parts?: unknown };
      const parts: unknown[] | undefined = Array.isArray(args.parts) ? args.parts : undefined;
      if (parts === undefined || parts.length === 0) {
        return {
          status: "error",
          error: {
            code: "validation",
            message: "vendo_parts takes the whole list of parts; an empty list is not an update",
          },
        };
      }
      return { status: "ok", output: { parts, next: NEXT_STEP } };
    },
  };
}
