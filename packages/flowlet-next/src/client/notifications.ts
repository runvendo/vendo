/**
 * Fetch-backed FlowletNotifications client (FlowletToasts, 2026-07-04 spec):
 * polls the handler's GET /deliveries?since=<cursor> and posts approvals to
 * POST /resume. Deliveries without a structured `automation` payload are not
 * toastable and are skipped.
 */
import type { AutomationDelivery, OutboundMessage } from "@flowlet/core";
import type { AutomationNotice, FlowletNotifications } from "@flowlet/shell";

interface DeliveriesBody {
  deliveries?: Array<{ cursor: number; message: OutboundMessage }>;
}

export function createServerNotifications(basePath: string): FlowletNotifications {
  return {
    async listSince(since) {
      const res = await fetch(`${basePath}/deliveries?since=${since}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`[flowlet] deliveries request failed (${res.status})`);
      const body = (await res.json()) as DeliveriesBody;
      const notices: AutomationNotice[] = [];
      for (const { cursor, message } of body.deliveries ?? []) {
        const automation: AutomationDelivery | undefined = message.automation;
        if (!automation) continue;
        notices.push({
          cursor,
          kind: automation.kind,
          runId: automation.runId,
          ...(automation.stepId !== undefined ? { stepId: automation.stepId } : {}),
          summary: automation.summary,
          text: message.text,
        });
      }
      return notices;
    },
    async resume(runId, approved, stepId) {
      const res = await fetch(`${basePath}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, approved, ...(stepId !== undefined ? { stepId } : {}) }),
      });
      if (!res.ok) throw new Error(`[flowlet] resume request failed (${res.status})`);
      const body = (await res.json()) as { stale?: boolean };
      return body.stale === true ? "stale" : "resumed";
    },
  };
}
