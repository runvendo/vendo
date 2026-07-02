import type { Principal } from "./principal";

/**
 * Channels seam — reaching the user off-thread (Decision 1).
 *
 * | Deployment | Implementation |
 * |---|---|
 * | Embedded | in-app only |
 * | Cloud | in-app now; SMS (ENG-191) and voice (ENG-185) later |
 *
 * Message-shaped delivery only. Realtime voice is a session, not a message —
 * it gets its own contract at ENG-185 time and is deliberately NOT squeezed
 * into `deliver`.
 */
export interface Channels {
  deliver(message: OutboundMessage): Promise<void>;
}

export type ChannelKind = "in-app" | "sms";

export interface OutboundMessage {
  channel: ChannelKind;
  principal: Principal;
  /** Plain-text body; in-app surfaces may upgrade rendering later. */
  text: string;
  /** Thread to attach in-app deliveries to; ignored by SMS. */
  threadId?: string;
}
