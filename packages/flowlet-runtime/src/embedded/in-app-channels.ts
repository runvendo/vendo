/**
 * Embedded implementation of the frozen Channels seam: in-app only
 * (architecture Decision 1's embedded row — SMS/voice are cloud transports).
 * Deliveries are recorded for tests and handed to an optional host callback;
 * any non in-app channel is rejected rather than silently dropped. The
 * callback is awaited: a failed host delivery rejects `deliver` and is NOT
 * recorded — resolving means the message actually reached the host surface.
 */
import type { Channels, OutboundMessage } from "@flowlet/core";

export interface InAppChannelsConfig {
  onDeliver?: (message: OutboundMessage) => void | Promise<void>;
}

export class InAppChannels implements Channels {
  readonly delivered: OutboundMessage[] = [];

  constructor(private readonly config: InAppChannelsConfig = {}) {}

  async deliver(message: OutboundMessage): Promise<void> {
    if (message.channel !== "in-app") {
      throw new Error(
        `InAppChannels only delivers "in-app" messages; got "${message.channel}" (embedded mode has no SMS/voice transport)`,
      );
    }
    await this.config.onDeliver?.(message);
    this.delivered.push(message);
  }
}
