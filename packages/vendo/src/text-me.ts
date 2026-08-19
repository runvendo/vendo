/**
 * `vendo_text_me` — one text to the person the run is FOR, from any surface.
 *
 * It exists because the text channel could only ever answer: a conversation the
 * user started, in the turn they started it. Everything that wants to reach them
 * later — an away automation, a web turn that finishes after they have closed the
 * tab — had nothing to call, so the channel's own grounding told the model to
 * point at the app and promise "coming soon" (channel-turn.ts). This is the other
 * half: the action an automation holds a grant for, so "text me when the rent
 * clears" is armed once and delivered forever.
 *
 * MISUSE RESISTANCE IS THE SHAPE, not a check: the input is `{ text }` and
 * nothing else. There is no number to pass, so no model output can aim a text at
 * a phone that is not the current subject's own — the destination is read from
 * the link row under `ctx.principal`, which only ever exists because that signed-in
 * user asked for it and texted a code back (channel-links.ts).
 *
 * Consent is the existing machinery, untouched: a `write` descriptor on the one
 * registry, so a present turn parks a card under whatever the host's policy says,
 * and an away firing needs the standing grant that arming mints (automations
 * `grants.ts`). No new consent path, no per-tool allowlist.
 */
import {
  VENDO_TOOL_TITLES,
  type Principal,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import type { ChannelLinkRepository } from "./channel-links.js";
import { PLAIN_TEXT_RULE } from "./channel-turn.js";
import type { ChannelsService, TextChannelInvite } from "./channels.js";

export const VENDO_TEXT_ME_TOOL = "vendo_text_me";

export interface TextMeDeps {
  channel: ChannelsService;
  links: ChannelLinkRepository;
  /** The connect flow's own invite — the same `sms:` URL the link page hands
   *  out, so an agent that finds no phone offers the ONE link that fixes it. */
  invite: (principal: Principal) => Promise<TextChannelInvite>;
}

const DESCRIPTOR: ToolDescriptor = {
  name: VENDO_TEXT_ME_TOOL,
  title: VENDO_TOOL_TITLES[VENDO_TEXT_ME_TOOL]!,
  description:
    "Send this user one text message on the phone they linked to their account. It reaches them from any "
    + "surface — a web chat, an app, an automation firing while they are away — and it can only ever reach "
    + "their own phone. In a text conversation, just reply: do not call this to answer the person you are "
    + "already texting. To text them later or on a schedule, set up an automation that calls this action; "
    + `the permission is granted once, when they arm it. ${PLAIN_TEXT_RULE}`,
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", minLength: 1 } },
    required: ["text"],
    additionalProperties: false,
  },
  risk: "write",
};

/** No phone this can reach — either nobody linked one, or the link is minutes
 *  old and the router has not carried a real message on it yet (a one-text link
 *  relays no conversation of its own). ONE sentence covers both, because the fix
 *  is the same: the person texts once. The invite is minted rather than described
 *  because a code expires (LINK_CODE_TTL_MS) and a stale one reads as a broken
 *  product. */
const noReachablePhone = (url: string) =>
  "There is no phone this can reach for this account yet — a phone becomes reachable once its owner has texted "
  + `here at least once. Tell them so plainly, and offer them this link, which opens a prefilled first message: ${url}`;

/** The router had the conversation and could not deliver on it (a lapsed
 *  iMessage assignment answers 404). Never a fabricated success: the model is
 *  told, in one sentence, that the text did NOT arrive. */
const NOT_REACHABLE =
  "The text did not go through — their phone is not reachable right now and the connection may have lapsed. "
  + "Say plainly that you could not text them, and that reconnecting their phone will fix it. Do not say you sent it.";

/**
 * The `vendo_text_me` door as a one-tool registry, composed alongside the others
 * (compose-channels.ts) and ONLY when a channel adapter is configured — the same
 * "no adapter, no tool" rule knowledge and the connector pair follow. A
 * deployment that never asked for texts must not be shown a tool whose every
 * call would refuse.
 */
export function textMeRegistry(deps: TextMeDeps): ToolRegistry {
  return {
    async descriptors() {
      return [DESCRIPTOR];
    },

    async execute(call, ctx: RunContext) {
      const args = (call.args ?? {}) as { text?: unknown };
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (text === "") {
        return { status: "error", error: { code: "validation", message: "Text me needs the message to send" } };
      }
      // The destination, read off the subject's own link row. A pending code is
      // not a link (`bySubject` answers claimed rows only), and a link with no
      // conversation is a phone the router has never carried a real message for.
      const link = await deps.links.bySubject(ctx.principal.subject);
      if (link?.conversationId === undefined) {
        const invite = await deps.invite(ctx.principal);
        return { status: "error", error: { code: "not-linked", message: noReachablePhone(invite.url) } };
      }
      try {
        await deps.channel.send({ conversationId: link.conversationId, text });
      } catch {
        // Loud, and the model's to explain. Rethrowing would surface as "the
        // tool is broken", which the agent retries; a result the person can act
        // on is what gets their phone reconnected.
        return { status: "error", error: { code: "unavailable", message: NOT_REACHABLE } };
      }
      return { status: "ok", output: { sent: true } };
    },
  };
}
