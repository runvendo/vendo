/**
 * The text-channel lane: which adapter carries the texts, where the link
 * binding lives, and the one door the wire and the host both call.
 */
import { VendoError } from "@vendoai/core";
import {
  CODE_PATTERN,
  ChannelAskRepository,
  ChannelLinkRepository,
  ChannelEventLog,
  maskPhone,
  normalizeCode,
} from "./channel-links.js";
import { runChannelTurn } from "./channel-turn.js";
import {
  channelInboundSecret as deriveInboundSecret,
  cloudTextChannel,
  isLinkEvent,
  unconfiguredChannels,
  type ChannelDoor,
  type ChannelsService,
} from "./channels.js";
import { cloudKeyOptions } from "./compose-selection.js";
import type { VendoComposition } from "./compose-context.js";
import type { CreateVendoConfig } from "./types.js";

/** The conversation ref a link delivery is logged under. Link events carry no
    conversation of their own, and the delivery log deliberately holds no phone,
    so they share one bucket: the rows still dedupe by event id and still age out
    on the same 24h prune. */
const LINK_DELIVERY_REF = "link";

/** ADAPTER RULE, channels seam (cloned from selectConnections). Precedence:
 *    1. `channels` unset or `{ text: false }` — no channel, and SILENTLY so:
 *       a deployment that never asked for texts must not be nagged about a key;
 *    2. `{ text: true }` + VENDO_API_KEY — the Cloud adapter (VENDO_CLOUD_URL
 *       overrides the console base URL);
 *    3. `{ text: true }` with no key — the unconfigured surface, naming the fix.
 *       Silently mounting nothing is the trap this ladder exists to avoid.
 *  The adapters themselves never read the environment. */
export function selectChannels(configured: CreateVendoConfig["channels"]): ChannelsService {
  if (configured?.text !== true) return unconfiguredChannels();
  const cloud = cloudKeyOptions();
  if (cloud === undefined) {
    return unconfiguredChannels(
      "createVendo({ channels: { text: true } }) asks Vendo Cloud to carry the texts (it owns the numbers "
      + "and the identity router): set VENDO_API_KEY, or drop the channels key",
    );
  }
  return cloudTextChannel(cloud);
}

export const composeChannels = (composition: VendoComposition): Pick<VendoComposition,
  "channels" | "channelDoor" | "channelInboundSecret"> => {
  const channels = selectChannels(composition.config.channels);
  const links = new ChannelLinkRepository(composition.store);
  const cloud = cloudKeyOptions();

  let secret: Promise<string> | undefined;
  // No channel, no door: a deployment that never opted in must not authenticate
  // a delivery at all, even though its Cloud key could derive the bearer. The
  // route then refuses every inbound text instead of standing open for free.
  const channelInboundSecret = (): Promise<string | undefined> =>
    cloud === undefined || channels.posture === false
      ? Promise.resolve(undefined)
      : (secret ??= deriveInboundSecret(cloud.apiKey));

  // Registration is a DEPLOYMENT fact, not a per-user one: the first link
  // publishes this deployment's inbound door and learns the identity every user
  // texts. Memoized on success only — a console blip must not fix "no channel"
  // for the life of the process.
  let registration: ReturnType<ChannelsService["register"]> | undefined;
  const register = async (): ReturnType<ChannelsService["register"]> => {
    const url = composition.urls?.publicUrl.href ?? composition.actionsConfig.baseUrl;
    if (url === undefined) {
      throw new VendoError(
        "validation",
        "the text channel needs this deployment's public URL to receive texts: set VENDO_BASE_URL",
      );
    }
    const inbound = await channelInboundSecret();
    if (inbound === undefined) {
      // Unreachable through the Cloud adapter (it only composes WITH a key);
      // an explicitly passed adapter has no secret to verify against either.
      throw new VendoError("not-implemented", "the text channel needs VENDO_API_KEY to register its inbound door");
    }
    registration ??= channels.register({ url: url.replace(/\/$/, ""), secret: inbound });
    try {
      return await registration;
    } catch (error) {
      registration = undefined;
      throw error;
    }
  };

  // Both of these live in the STORE, not in this closure. A deployment is a
  // request handler: on a serverless host consecutive deliveries land on
  // different instances, and a restart parts any two of them. In-memory state
  // here reads as "never seen it" on the instance that needs it most — the one
  // holding the retry, or the one holding the "YES".
  const delivered = new ChannelEventLog(composition.store);
  const asks = new ChannelAskRepository(composition.store);

  const door: ChannelDoor = {
    async invite(principal) {
      const identity = await register();
      const link = await links.mint(principal.subject);
      const command = `${identity.connectCommand} ${link.code}`;
      // `?&body=` is the spelling both iOS and Android accept for a prefilled
      // SMS body; either one alone works on only one of them.
      return {
        url: `sms:${identity.number}?&body=${encodeURIComponent(command)}`,
        number: identity.number,
        code: link.code!,
        command,
      };
    },

    async status(principal) {
      const link = await links.bySubject(principal.subject);
      return link?.phone === undefined ? { linked: false } : { linked: true, phone: maskPhone(link.phone) };
    },

    async unlink(principal) {
      await links.unlink(principal.subject);
    },

    async inbound(event) {
      if (isLinkEvent(event)) {
        // The one-text flow: the router kept the connect message, Cloud read the
        // tail off its transcript, and this arrives just AHEAD of the person's
        // first real message. Claimed silently — the reply they get is the answer
        // to what they actually asked, not a receipt for a code they never typed.
        // A code that is unknown, spent or expired answers null and says nothing,
        // which is also what makes a re-relayed connect harmless.
        if (!await delivered.claim(event.eventId, LINK_DELIVERY_REF)) return;
        await links.claim(event.code, event.from);
        return;
      }
      if (!await delivered.claim(event.eventId, event.conversationId)) return;
      // A text that IS a live code claims the link — whether the phone is a
      // stranger sending the second text of a link, or an already-linked phone
      // moving to another account. `claim` answers null for anything that is
      // not a live code, so an ordinary message falls straight through.
      if (CODE_PATTERN.test(normalizeCode(event.text))) {
        const claimed = await links.claim(event.text, event.from);
        if (claimed !== null) {
          await channels.send({
            conversationId: event.conversationId,
            text: "You're linked. Text me anything you'd do in the app.",
          });
          return;
        }
      }
      const known = await links.byPhone(event.from);
      // A phone nobody linked is a stranger: served nothing, told nothing.
      if (known === null) return;
      await runChannelTurn(
        {
          harness: composition.harnessDoor,
          guard: composition.guard,
          channel: channels,
          links,
          asks,
        },
        { event, link: known },
      );
    },
  };

  return { channels, channelDoor: door, channelInboundSecret };
};
