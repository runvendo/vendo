/**
 * Embedded implementation of the frozen Channels seam: in-app only
 * (architecture Decision 1's embedded row — SMS/voice are cloud transports).
 * Deliveries are recorded for tests and handed to an optional host callback;
 * any non in-app channel is rejected rather than silently dropped. The
 * callback is awaited: a failed host delivery rejects `deliver` and is NOT
 * recorded — resolving means the message actually reached the host surface.
 *
 * Deliveries are also retained in a capped, cursor-stamped log so a polling
 * client (VendoToasts via the vendo/server deliveries route) can read
 * everything for its principal since its last cursor. Cursors are monotonic
 * per instance and survive retention drops.
 */
import type { Channels, OutboundMessage, Principal } from "@vendoai/core";

export interface InAppChannelsConfig {
  onDeliver?: (message: OutboundMessage) => void | Promise<void>;
  /** Max retained deliveries for polling reads (oldest dropped first). */
  retention?: number;
}

export interface RetainedDelivery {
  cursor: number;
  message: OutboundMessage;
}

const DEFAULT_RETENTION = 500;

export class InAppChannels implements Channels {
  readonly delivered: OutboundMessage[] = [];
  private retained: RetainedDelivery[] = [];
  private nextCursor = 1;

  constructor(private readonly config: InAppChannelsConfig = {}) {}

  async deliver(message: OutboundMessage): Promise<void> {
    if (message.channel !== "in-app") {
      throw new Error(
        `InAppChannels only delivers "in-app" messages; got "${message.channel}" (embedded mode has no SMS/voice transport)`,
      );
    }
    await this.config.onDeliver?.(message);
    this.delivered.push(message);
    this.retained.push({ cursor: this.nextCursor++, message });
    const cap = this.config.retention ?? DEFAULT_RETENTION;
    if (this.retained.length > cap) this.retained = this.retained.slice(-cap);
  }

  /** Deliveries for `scope` with cursor > `since`, oldest first. */
  listSince(scope: Principal, since: number): RetainedDelivery[] {
    return this.retained.filter(
      (d) =>
        d.cursor > since &&
        d.message.principal.tenantId === scope.tenantId &&
        d.message.principal.subject === scope.subject,
    );
  }
}
