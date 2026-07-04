/**
 * Cadence's `parkedActions` shell seam (ENG-193 §4.6): fetches unresolved
 * parked actions from this app's own routes (parked-actions-handler.ts) and
 * maps the raw store rows into the shell's `ParkedActionRow` shape.
 *
 * Two shape gaps the wire object doesn't close on its own:
 *  - The store row carries the frozen `input` (unknown), not a rendered
 *    preview string — `fieldValue` (the same flattener ApprovalCard/
 *    ActivityStep use) turns it into readable "Key: value" lines.
 *  - `guardStale` on the STORE row is a resolve-time-only field (stamped by
 *    `AutomationRunner.resolveParkedAction` AFTER a guard re-check attempt),
 *    so it can't describe an unresolved row. This derives the same signal
 *    BEFORE approval, from the row's own `guardExpr`, using the identical
 *    "references steps.*" boundary the runner itself re-checks against
 *    (packages/flowlet-runtime/src/automations/runner.ts) — so a row the
 *    runner will never re-check its guard for is flagged up front, not only
 *    after the fact.
 */
import { fieldValue, type ParkedActionRow } from "@flowlet/shell";

interface RawParkedAction {
  id: string;
  tool: string;
  tier: "act" | "critical";
  input: unknown;
  requestedAt: string;
  guardExpr?: string;
}

const MAX_PREVIEW_CHARS = 160;

function toRow(action: RawParkedAction): ParkedActionRow {
  return {
    id: action.id,
    tool: action.tool,
    tier: action.tier,
    inputPreview: fieldValue(action.input, MAX_PREVIEW_CHARS),
    requestedAt: action.requestedAt,
    guardStale: action.guardExpr !== undefined && /\bsteps\s*[.[]/.test(action.guardExpr),
  };
}

export async function listParkedActions(): Promise<ParkedActionRow[]> {
  const res = await fetch("/api/flowlet/parked-actions");
  const json = (await res.json().catch(() => ({}))) as { actions?: RawParkedAction[]; error?: string };
  if (!res.ok) throw new Error(json.error ?? `failed to list parked actions (${res.status})`);
  return (json.actions ?? []).map(toRow);
}

export async function resolveParkedAction(actionId: string, decision: "yes" | "no"): Promise<void> {
  const res = await fetch("/api/flowlet/parked-actions/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actionId, decision }),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error((json as { error?: string }).error ?? `failed to resolve parked action (${res.status})`);
  }
}
