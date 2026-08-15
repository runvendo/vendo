/**
 * A canned `data-vendo-debug` sequence, pushed through the real receiver door so
 * the pane can be looked at before a harness is wired to it. Dev tooling for this
 * pane only — it proves nothing about the producer, which publishes the same
 * parts over the wire.
 *
 * Every beat here is one the PRODUCER can actually emit, and that is the whole
 * discipline of this file: a demo richer than reality teaches the pane to render
 * a turn no harness will ever send. So —
 *  - no `tool` beat for `find_tools`, `hire_subagent`, `save_app` or `escalate`:
 *    those are harness HANDS, run in-process, and only `turn.tools.call()` reaches
 *    the workbench (`turn-tools.ts`). A search leaves one trace, the loadout it
 *    re-publishes;
 *  - `stopReason` is the ai-SDK's own finish reason, and steps count from zero;
 *  - `searchedIn` carries the tool NAMES a search loaded, never the query;
 *  - `alwaysActive` is `active.filter(isAlwaysActive)`, so only a `vendo_` name
 *    (or a connector-discovery tool) can appear in it, and a closed loadout
 *    withholds nothing because its active set IS its equipped set;
 *  - a hire and the screen agent share the RESIDENT'S turn — the channel is keyed
 *    on the runtime's turnId — so their parts interleave with its own on one
 *    stream, each counting its own steps from zero.
 */
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

/** The starting toolbelt `computeInitialLoadout` cuts, plus the two hands. The
 *  loop re-reads this each step, so every `step-start` in a turn that never
 *  searches reports the same set. */
const STARTING_TOOLS = [
  "find_tools",
  "hire_subagent",
  "vendo_make",
  "ask_user",
  "host_listCards",
  "host_getSpendingInsights",
];

/** …and the same set after `find_tools` pulled four more in. */
const SEARCHED_IN = [
  "host_getCardPan",
  "host_getCardTransactions",
  "host_setCardControls",
  "host_getIssuerRules",
];
const EXPANDED_TOOLS = [...STARTING_TOOLS, ...SEARCHED_IN];

/** A turn that never searches: `find_tools` is equipped and unused. */
const BALANCE: Beat[] = [
  ["resident", 0, { kind: "loadout", active: STARTING_TOOLS, searchedIn: [], alwaysActive: ["vendo_make"], withheldCount: 98 }],
  ["resident", 40, { kind: "context", estTokens: 6_100, windowTokens: 200_000, triggerTokens: 162_000 }],
  ["resident", 90, { kind: "step-start", step: 0, maxSteps: 20, activeTools: STARTING_TOOLS }],
  ["resident", 260, { kind: "tool", step: 0, toolCallId: "b1", name: "host_listCards", argsPreview: '{ status: "active" }', status: "ok", guard: "run", approval: "auto", durationMs: 168 }],
  ["resident", 480, { kind: "step-end", step: 0, stopReason: "tool-calls", durationMs: 390, usage: { inputTokens: 5_980, outputTokens: 74 } }],
  ["resident", 620, { kind: "step-start", step: 1, maxSteps: 20, activeTools: STARTING_TOOLS }],
  ["resident", 1_450, { kind: "step-end", step: 1, stopReason: "stop", durationMs: 830, usage: { inputTokens: 6_340, outputTokens: 212 } }],
];

/** A turn that searches and then hires. The hire drives the same loop, so it
 *  opens a step of its OWN — its step 0 is not the resident's. */
const DECLINES: Beat[] = [
  ["resident", 0, { kind: "loadout", active: STARTING_TOOLS, searchedIn: [], alwaysActive: ["vendo_make"], withheldCount: 98 }],
  ["resident", 40, { kind: "context", estTokens: 8_200, windowTokens: 200_000, triggerTokens: 162_000 }],
  ["resident", 120, { kind: "step-start", step: 0, maxSteps: 20, activeTools: STARTING_TOOLS }],
  ["resident", 380, { kind: "loadout", active: EXPANDED_TOOLS, searchedIn: SEARCHED_IN, alwaysActive: ["vendo_make"], withheldCount: 94 }],
  ["resident", 940, { kind: "step-end", step: 0, stopReason: "tool-calls", durationMs: 820, usage: { inputTokens: 4_212, outputTokens: 128 } }],
  ["resident", 1_100, { kind: "step-start", step: 1, maxSteps: 20, activeTools: EXPANDED_TOOLS }],
  ["resident", 1_440, { kind: "tool", step: 1, toolCallId: "c2", name: "host_listCards", argsPreview: '{ status: "active" }', status: "ok", guard: "run", approval: "auto", durationMs: 340 }],
  ["resident", 2_560, { kind: "tool", step: 1, toolCallId: "c3", name: "host_getSpendingInsights", argsPreview: '{ window: "30d", groupBy: "declineReason" }', status: "ok", guard: "run", approval: "auto", durationMs: 812 }],
  ["resident", 2_720, { kind: "step-end", step: 1, stopReason: "tool-calls", durationMs: 1_620, usage: { inputTokens: 9_480, outputTokens: 96 } }],
  ["resident", 3_000, { kind: "step-start", step: 2, maxSteps: 20, activeTools: EXPANDED_TOOLS }],
  ["resident", 11_100, { kind: "tool", step: 2, toolCallId: "c4", name: "host_getCardPan", argsPreview: '{ cardId: "crd_4417", reveal: "last4" }', status: "ok", guard: "ask", approval: "approved", durationMs: 8_100 }],
  ["resident", 12_200, { kind: "tool", step: 2, toolCallId: "c5", name: "host_getCardTransactions", argsPreview: '{ cardId: "crd_4417", status: "declined", limit: 25 }', status: "ok", guard: "run", approval: "auto", durationMs: 486 }],
  ["resident", 12_620, { kind: "step-end", step: 2, stopReason: "tool-calls", durationMs: 9_620, usage: { inputTokens: 12_910, outputTokens: 402 } }],
  ["resident", 12_700, { kind: "step-start", step: 3, maxSteps: 20, activeTools: EXPANDED_TOOLS }],
  ["resident", 102_600, { kind: "tool", step: 3, toolCallId: "c6", name: "host_setCardControls", argsPreview: '{ cardId: "crd_4417", controls: { onlineTx: false } }', status: "denied", guard: "ask", approval: "timed-out", durationMs: 90_000 }],
  ["resident", 102_800, { kind: "step-end", step: 3, stopReason: "tool-calls", durationMs: 90_100, usage: { inputTokens: 14_220, outputTokens: 188 } }],
  ["resident", 103_000, { kind: "step-start", step: 4, maxSteps: 20, activeTools: EXPANDED_TOOLS }],
  ["subagent", 103_100, { kind: "context", estTokens: 5_900, windowTokens: 200_000, triggerTokens: 162_000 }],
  ["subagent", 103_200, { kind: "step-start", step: 0, maxSteps: 12, activeTools: ["host_getIssuerRules", "host_getCardTransactions", "host_disputeTransaction"] }],
  ["subagent", 104_200, { kind: "tool", step: 0, toolCallId: "c8", name: "host_disputeTransaction", argsPreview: '{ txnId: "txn_88a1" }', status: "denied", guard: "block", approval: "denied", durationMs: 12 }],
  ["subagent", 107_900, { kind: "step-end", step: 0, stopReason: "stop", durationMs: 4_700, usage: { inputTokens: 6_120, outputTokens: 244 } }],
  ["subagent", 108_300, { kind: "subagent", label: "issuer-rule check", steps: 1, maxSteps: 12, report: "All three declines carry issuer rule R-118, which rejects card-not-present charges to MCC 5967 on cards issued in the last 90 days. Balance was never the cause." }],
  ["resident", 109_200, { kind: "step-end", step: 4, stopReason: "tool-calls", durationMs: 6_200, usage: { inputTokens: 15_040, outputTokens: 620 } }],
  ["resident", 109_400, { kind: "step-start", step: 5, maxSteps: 20, activeTools: EXPANDED_TOOLS }],
  ["resident", 111_800, { kind: "step-end", step: 5, stopReason: "stop", durationMs: 2_400, usage: { inputTokens: 16_100, outputTokens: 486 } }],
];

/** The screen agent's closed loadout — `vendo({ tools })`, the drive `vendo_make`
 *  starts inside the resident's own step. It searches nothing in and withholds
 *  nothing, which is what makes the tools tab's closed reading an answer. */
const SCREEN_TOOLS = ["validate", "save_app", "escalate", "host_getSpendingInsights"];

/** A turn under real window pressure that ends by painting a screen. */
const SPEND: Beat[] = [
  ["resident", 0, { kind: "loadout", active: STARTING_TOOLS, searchedIn: [], alwaysActive: ["vendo_make"], withheldCount: 98 }],
  // The host set a `contextTokenBudget`, so the floor sheds before anything else
  // measures — and the trigger below still trips on what is left.
  ["resident", 40, { kind: "shed", dropped: 2 }],
  ["resident", 60, { kind: "context", estTokens: 178_400, windowTokens: 200_000, triggerTokens: 162_000 }],
  ["resident", 3_400, { kind: "compaction", reason: "trigger", summary: SUMMARY }],
  ["resident", 3_500, { kind: "step-start", step: 0, maxSteps: 20, activeTools: STARTING_TOOLS }],
  ["resident", 3_900, { kind: "tool", step: 0, toolCallId: "s0", name: "host_getSpendingInsights", argsPreview: '{ window: "90d", groupBy: "category" }', status: "ok", guard: "run", approval: "auto", durationMs: 402 }],
  ["resident", 4_400, { kind: "step-end", step: 0, stopReason: "tool-calls", durationMs: 900, usage: { inputTokens: 41_200, outputTokens: 96 } }],
  ["resident", 4_600, { kind: "step-start", step: 1, maxSteps: 20, activeTools: STARTING_TOOLS }],
  ["screen", 4_800, { kind: "loadout", active: SCREEN_TOOLS, searchedIn: [], alwaysActive: [], withheldCount: 0 }],
  ["screen", 4_900, { kind: "context", estTokens: 38_900, windowTokens: 200_000, triggerTokens: 162_000 }],
  ["screen", 5_000, { kind: "step-start", step: 0, maxSteps: 10, activeTools: SCREEN_TOOLS }],
  ["screen", 5_640, { kind: "tool", step: 0, toolCallId: "s1", name: "host_getSpendingInsights", argsPreview: '{ window: "90d", groupBy: "category" }', status: "ok", guard: "run", approval: "auto", durationMs: 640 }],
  ["screen", 7_100, { kind: "step-end", step: 0, stopReason: "tool-calls", durationMs: 2_100, usage: { inputTokens: 6_040, outputTokens: 188 } }],
  ["screen", 7_400, { kind: "step-start", step: 1, maxSteps: 10, activeTools: SCREEN_TOOLS }],
  ["screen", 8_120, { kind: "tool", step: 1, toolCallId: "s2", name: "validate", argsPreview: '{ appId: "app_spend" }', status: "error", guard: "run", approval: "auto", durationMs: 420 }],
  ["screen", 9_300, { kind: "step-end", step: 1, stopReason: "stop", durationMs: 1_900, usage: { inputTokens: 13_660, outputTokens: 142 } }],
  // The resident's own `vendo_make` call closes only once the drive above is
  // done, which is why its beat lands last.
  ["resident", 9_500, { kind: "tool", step: 1, toolCallId: "s3", name: "vendo_make", argsPreview: '{ appId: "app_spend", intent: "Spending by category" }', status: "ok", guard: "run", approval: "auto", durationMs: 4_900 }],
  ["resident", 9_700, { kind: "step-end", step: 1, stopReason: "tool-calls", durationMs: 5_100, usage: { inputTokens: 48_900, outputTokens: 310 } }],
  ["resident", 9_900, { kind: "step-start", step: 2, maxSteps: 20, activeTools: STARTING_TOOLS }],
  ["resident", 11_200, { kind: "step-end", step: 2, stopReason: "stop", durationMs: 1_300, usage: { inputTokens: 49_400, outputTokens: 168 } }],
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
  publish("thr_balance", BALANCE, now - 400_000);
  publish("thr_declines", DECLINES, now - 200_000);
  publish("thr_spend", SPEND, now - 40_000);
}
