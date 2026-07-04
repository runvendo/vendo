/**
 * Cadence's `sendConsent` shell seam (ENG-193 §4.5): POSTs every approval/
 * decline decision to this app's own /api/flowlet/consent route
 * (consent-handler.ts), which validates it against the pending approval part
 * and appends the "consent" audit event (and mints a grant when one is
 * drafted). Best-effort by contract — FlowletThread swallows a failed POST so
 * the SDK's native approval boolean always proceeds.
 *
 * The route's body shape is the same one /chat uses: `id` is the CLIENT chat/
 * thread id (resolved server-side to the persisted thread record), plus the
 * toolCallId/toolName the server cross-checks against the persisted part.
 */
import type { ConsentResponse } from "@flowlet/core";

export function createSendConsent(threadId: string) {
  return async (response: ConsentResponse, meta: { toolName: string }): Promise<void> => {
    const res = await fetch("/api/flowlet/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: threadId,
        toolCallId: response.id,
        toolName: meta.toolName,
        response,
      }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error((json as { error?: string }).error ?? `consent POST failed (${res.status})`);
    }
  };
}
