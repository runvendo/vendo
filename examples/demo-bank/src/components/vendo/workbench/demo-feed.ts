/** A canned `data-vendo-debug` sequence, pushed through the real receiver door
 *  so the pane can be looked at before a harness is wired to it. Dev tooling
 *  for this pane only — it proves nothing about the producer, which publishes
 *  the same parts over the wire. */
import { publishWorkbenchPart, type WorkbenchEvent, type WorkbenchPart } from "@vendoai/ui";

type Beat = [agent: WorkbenchPart["agent"], offsetMs: number, event: WorkbenchEvent];

const SUMMARY = `## Goal
Explain why the user's Maple card (•••• 4417) keeps getting declined.

## Constraints & Preferences
- Lead with the cause, then the fix. Keep it short.
- Never change card controls without approval.

## Progress
### Done
- Pulled active cards and 30d insights.
- Found 3 declines in 8 days, all merchant category 5967.
### Blocked
- host_setCardControls sits behind an approval the user never answered.

## Key Decisions
- Attribute the declines to the issuer's category rule, not to balance.

## Next Steps
1. Re-offer the control change as an explicit choice, never an auto-action.

## Critical Context
- cardId crd_4417. Decline codes: 05 ×2, 57 ×1.`;

const DECLINES: Beat[] = [
  ["resident", 0, { kind: "step-start", step: 1, maxSteps: 20, activeTools: ["find_tools", "vendo_make", "ask_user"] }],
  ["resident", 210, { kind: "tool", step: 1, toolCallId: "c1", name: "find_tools", argsPreview: '{ query: "card declines, card controls" }', status: "ok", guard: "run", approval: "auto", durationMs: 210 }],
  ["resident", 240, { kind: "loadout", active: ["find_tools", "vendo_make", "ask_user", "host_listCards", "host_getCardPan", "host_setCardControls", "host_getIssuerRules"], searchedIn: ["card declines, card controls, spending limits", "monthly spend by category"], alwaysActive: ["find_tools", "vendo_make", "ask_user", "hire_subagent"], withheldCount: 94 }],
  ["resident", 940, { kind: "step-end", step: 1, stopReason: "toolUse", durationMs: 940, usage: { inputTokens: 4212, outputTokens: 128 } }],
  ["resident", 1_100, { kind: "step-start", step: 2, maxSteps: 20, activeTools: ["host_listCards", "host_getSpendingInsights"] }],
  ["resident", 1_440, { kind: "tool", step: 2, toolCallId: "c2", name: "host_listCards", argsPreview: '{ status: "active" }', status: "ok", guard: "run", approval: "auto", durationMs: 340 }],
  ["resident", 2_560, { kind: "tool", step: 2, toolCallId: "c3", name: "host_getSpendingInsights", argsPreview: '{ window: "30d", groupBy: "declineReason" }', status: "ok", guard: "run", approval: "auto", durationMs: 812 }],
  ["resident", 2_720, { kind: "step-end", step: 2, stopReason: "toolUse", durationMs: 1_620, usage: { inputTokens: 9480, outputTokens: 96 } }],
  ["resident", 2_900, { kind: "context", estTokens: 21_400, windowTokens: 200_000, triggerTokens: 162_000 }],
  ["resident", 3_000, { kind: "step-start", step: 3, maxSteps: 20, activeTools: ["host_getCardPan", "host_getCardTransactions"] }],
  ["resident", 11_100, { kind: "tool", step: 3, toolCallId: "c4", name: "host_getCardPan", argsPreview: '{ cardId: "crd_4417", reveal: "last4" }', status: "ok", guard: "ask", approval: "approved", durationMs: 8_100 }],
  ["resident", 12_200, { kind: "tool", step: 3, toolCallId: "c5", name: "host_getCardTransactions", argsPreview: '{ cardId: "crd_4417", status: "declined", limit: 25 }', status: "ok", guard: "run", approval: "auto", durationMs: 486 }],
  ["resident", 12_620, { kind: "step-end", step: 3, stopReason: "toolUse", durationMs: 9_620, usage: { inputTokens: 12_910, outputTokens: 402 } }],
  ["resident", 12_700, { kind: "step-start", step: 4, maxSteps: 20, activeTools: ["host_setCardControls"] }],
  ["resident", 102_600, { kind: "tool", step: 4, toolCallId: "c6", name: "host_setCardControls", argsPreview: '{ cardId: "crd_4417", controls: { onlineTx: false } }', status: "denied", guard: "ask", approval: "timed-out", durationMs: 90_000 }],
  ["resident", 102_800, { kind: "step-end", step: 4, stopReason: "toolUse", durationMs: 91_400, usage: { inputTokens: 14_220, outputTokens: 188 } }],
  ["resident", 103_000, { kind: "step-start", step: 5, maxSteps: 20, activeTools: ["hire_subagent"] }],
  ["resident", 103_900, { kind: "tool", step: 5, toolCallId: "c7", name: "hire_subagent", argsPreview: '{ goal: "do issuer rules explain the declines?" }', status: "ok", guard: "run", approval: "auto", durationMs: 4_410 }],
  ["subagent", 104_200, { kind: "tool", step: 5, toolCallId: "c8", name: "host_disputeTransaction", argsPreview: '{ txnId: "txn_88a1" }', status: "denied", guard: "block", approval: "denied", durationMs: 12 }],
  ["subagent", 108_300, { kind: "subagent", label: "issuer-rule check", steps: 7, maxSteps: 12, report: "All three declines carry issuer rule R-118, which rejects card-not-present charges to MCC 5967 on cards issued in the last 90 days. Balance was never the cause." }],
  ["resident", 108_400, { kind: "error", code: "context-overflow", message: "prompt 203,880 > 200,000 — retried once" }],
  ["resident", 108_450, { kind: "shed", dropped: 2 }],
  ["resident", 109_000, { kind: "compaction", reason: "overflow-retry", summary: SUMMARY }],
  ["resident", 109_100, { kind: "context", estTokens: 87_400, windowTokens: 200_000, triggerTokens: 162_000 }],
  ["resident", 109_200, { kind: "step-end", step: 5, stopReason: "toolUse", durationMs: 4_900, usage: { inputTokens: 15_040, outputTokens: 620 } }],
  ["resident", 112_400, { kind: "step-start", step: 6, maxSteps: 20, activeTools: ["vendo_make"] }],
  ["resident", 112_500, { kind: "tool", step: 6, toolCallId: "c9", name: "vendo_make", argsPreview: '{ appId: "app_declines", intent: "Declined charges explainer" }', status: "ok", guard: "run", approval: "auto", durationMs: 2_910 }],
];

/** The screen agent: a closed loadout, no compaction, no sub-run — the turn
 *  that shows the pane's empty states are answers, not gaps. */
const SPEND: Beat[] = [
  ["screen", 0, { kind: "step-start", step: 1, maxSteps: 10, activeTools: ["search_components", "save_app", "validate", "escalate"] }],
  ["screen", 100, { kind: "loadout", active: ["search_components", "save_app", "validate", "escalate", "host_getSpendingInsights"], searchedIn: [], alwaysActive: ["save_app", "validate", "escalate"], withheldCount: 119 }],
  ["screen", 640, { kind: "tool", step: 1, toolCallId: "s1", name: "search_components", argsPreview: '{ query: "stat tile, category bar list" }', status: "ok", guard: "run", approval: "auto", durationMs: 640 }],
  ["screen", 2_100, { kind: "step-end", step: 1, stopReason: "toolUse", durationMs: 2_100, usage: { inputTokens: 6_040, outputTokens: 188 } }],
  ["screen", 2_400, { kind: "context", estTokens: 38_900, windowTokens: 200_000, triggerTokens: 162_000 }],
  ["screen", 2_500, { kind: "step-start", step: 2, maxSteps: 10, activeTools: ["save_app", "validate"] }],
  ["screen", 3_700, { kind: "tool", step: 2, toolCallId: "s2", name: "save_app", argsPreview: '{ appId: "app_spend", version: "draft" }', status: "ok", guard: "run", approval: "auto", durationMs: 1_200 }],
  ["screen", 4_120, { kind: "tool", step: 2, toolCallId: "s3", name: "validate", argsPreview: '{ appId: "app_spend" }', status: "error", guard: "run", approval: "auto", durationMs: 420 }],
  ["screen", 4_300, { kind: "step-end", step: 2, stopReason: "endTurn", durationMs: 1_800, usage: { inputTokens: 13_660, outputTokens: 142 } }],
  ["screen", 4_400, { kind: "step-limit", steps: 2 }],
];

function publish(turnId: string, beats: Beat[], at: number): void {
  beats.forEach(([agent, offsetMs, event], index) => {
    publishWorkbenchPart({
      type: "data-vendo-debug",
      data: { turnId, seq: index + 1, at: at + offsetMs, agent, event } satisfies WorkbenchPart,
    });
  });
}

export function pushDemoFeed(): void {
  const now = Date.now();
  publish("thr_declines", DECLINES, now - 200_000);
  publish("thr_spend", SPEND, now - 40_000);
}
