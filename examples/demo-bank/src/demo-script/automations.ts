/**
 * Maple's scripted-demo automation documents. Kept free of the Vendo server
 * composition (./seed owns that) so they stay cheap to import and assert on.
 *
 * The set is deliberately unbalanced toward the last one. rehearse()'s payoff
 * is the WRITE path — reads execute for real under the guard's rehearsal
 * venue, while write/destructive tools never reach the registry and resolve to
 * a simulated card carrying the fully resolved args — so a set of pure-read
 * automations rehearses to previews and nothing else:
 *
 *   weekly     — reads only. The scripted "email me a weekly summary" beat.
 *   lowbalance — reads only. The scripted overdraft-alert beat.
 *   sweep      — read -> DESTRUCTIVE. The rehearsal showcase.
 *
 * All are seeded DISABLED: rehearsal is the pre-enable confidence step.
 */
import type { AppDocument } from "@vendoai/core";

/** Deterministic per-user app ids (app row ids are global, one subject each). */
export function demoAppId(
  key: "spending" | "moneyhq" | "weekly" | "lowbalance" | "sweep",
  subject: string,
): string {
  return `app_demo_${key}_${subject}`;
}

/** The week's real spending, excluding income and internal transfers — a
 *  payroll deposit or a $1,000 move to savings is not money spent. Shared by
 *  the sweep's guard, amount and memo so the three can never disagree. */
const SWEEP_SPEND =
  "steps.week.data.data[amount < 0 and category != 'transfer' and category != 'income']";

function weeklySummaryDocument(id: string): AppDocument {
  return {
    format: "vendo/app@1",
    id,
    name: "Weekly spending summary",
    description:
      "Every Friday at 5:00 PM, compile a digest of that week's spending by category to review.",
    trigger: {
      on: { kind: "schedule", cron: "0 17 * * 5" },
      // Steps run model: the capture surface stays exactly these host reads
      // (an agentic run would conservatively capture EVERY bound tool).
      run: {
        kind: "steps",
        steps: [
          { id: "spending", tool: "host_getSpendingInsights" },
          { id: "transactions", tool: "host_listTransactions" },
        ],
      },
    },
  };
}

function lowBalanceAlertDocument(id: string): AppDocument {
  return {
    format: "vendo/app@1",
    id,
    name: "Low balance check",
    description:
      "Every morning at 8:00 AM, check your Maple Checking balance so a low balance is easy to catch.",
    trigger: {
      on: { kind: "schedule", cron: "0 8 * * *" },
      // One host read keeps the standing-grant surface to a single consent
      // moment in the scripted beat (a read-only morning balance check, like
      // the weekly digest above).
      run: {
        kind: "steps",
        steps: [{ id: "balance", tool: "host_listAccounts" }],
      },
    },
  };
}

/**
 * The rehearsal showcase: read -> DESTRUCTIVE, with a different dollar figure
 * every firing.
 *
 * The two automations above are pure reads, so a rehearsal of either shows
 * rows and previews and nothing else — necessary as a baseline, not sufficient
 * as a demo. rehearse()'s payoff is the write path: host_transferMoney (risk
 * "destructive") never reaches the registry and resolves to the guard's
 * simulated card carrying the fully resolved arguments, under Maple's
 * ask-on-write policy.
 *
 * Two properties make this the strongest rehearsal subject in either demo host:
 *
 *  - host_listTransactions declares string `from`/`to`, so the engine pins each
 *    firing's window onto it (`acceptsDateBounds`) and every replayed firing
 *    reads a genuinely different week of real transactions — no projection
 *    needed, because transactions are natively time-series.
 *  - the transfer amount is DERIVED from that read, so the simulated card
 *    shows a different amount each week rather than a constant.
 *
 * `limit` is pinned well above a week's volume (the seed generates 0-3
 * transactions a day) so the sweep can never silently under-count against
 * listTransactions' default 25-row page.
 */
function savingsSweepDocument(id: string): AppDocument {
  return {
    format: "vendo/app@1",
    id,
    name: "Friday savings sweep",
    description:
      "Every Friday at 6:00 PM, move 10% of that week's spending into Maple Savings.",
    trigger: {
      on: { kind: "schedule", cron: "0 18 * * 5" },
      run: {
        kind: "steps",
        steps: [
          { id: "week", tool: "host_listTransactions", args: { limit: "200" } },
          {
            id: "sweep",
            tool: "host_transferMoney",
            // A week with no spending would resolve `amount` to nothing, and
            // the tool requires a positive integer — skip the firing instead.
            if: `$count(${SWEEP_SPEND}) > 0`,
            args: {
              amount: `$round($abs($sum(${SWEEP_SPEND}.amount)) * 0.1)`,
              recipient_name: "'Maple Savings'",
              memo:
                `'Auto-sweep: 10% of ' & $formatNumber($abs($sum(${SWEEP_SPEND}.amount)) / 100, '#,##0.00')`
                + ` & ' spent this week'`,
            },
          },
        ],
      },
    },
  };
}

/** The scripted-demo automations for one seeded subject (fixture microapps
 *  live in ./seed — those are apps, not automations). */
export function mapleDemoAutomations(subject: string): AppDocument[] {
  return [
    weeklySummaryDocument(demoAppId("weekly", subject)),
    lowBalanceAlertDocument(demoAppId("lowbalance", subject)),
    savingsSweepDocument(demoAppId("sweep", subject)),
  ];
}
