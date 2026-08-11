/**
 * The mark on a text part the MODEL reads and a person never sees (spec §16 law
 * 3). An affordance that opens a conversation about a specific thing — the ✦
 * remix popover, a connect card's "Not now" — has to tell the agent WHICH
 * thing, and a text part is the only channel that reaches the model
 * (`convertToModelMessages` keeps text and drops metadata and data parts). So
 * the grounding rides the sent message as its own marked text part.
 *
 * The mark lives in the TEXT, not only in `providerMetadata`: the wire contract
 * permits a store to persist a text part as `{ type, text }`, and the chrome's
 * own connect answers are sent as bare `{ text }` with no metadata at all. Text
 * is therefore the half that always survives, and this is the half every
 * package can trust.
 *
 * It lives in core because both ends need it. The chrome writes it, and the
 * SERVER has to recognise it too, or a hidden line becomes something a person
 * reads: `deriveTitle` (@vendoai/agent) took the first user text part it found,
 * so a fresh thread whose first message was a hidden connect answer was
 * persisted — and listed in the thread rail — as
 * "[vendo:context] Declined to connect Gmail."
 */
export const AGENT_CONTEXT_MARK = "[vendo:context]";

/** Whether a text part's own text carries the mark. The chrome's `isAgentContext`
 *  layers the richer `providerMetadata` check on top of this; anything outside the
 *  chrome has only the text, which is exactly why the mark rides it. */
export function isAgentContextText(text: string): boolean {
  return text.trimStart().startsWith(AGENT_CONTEXT_MARK);
}
