/**
 * The drop-in detector. Polls Maple's EXISTING transactions API (never a backend
 * hook — true to "we didn't touch the bank"), diffs for genuinely new rows, and
 * fires any matching rule's Slack message.
 *
 * Baseline-on-first-poll: every transaction present at startup (including the
 * planted $87 charge, which also matches the late-night rule) is marked seen, so
 * only orders placed AFTER the poller starts can trip a rule. Idempotent: each
 * new transaction is evaluated once.
 */
import { listTransactions } from "@/server/transactions"
import type { Transaction } from "@/server/types"
import { matchRules, type Rule, type TxLike } from "./rules-store"
import { pacificHour, pacificTimeLabel } from "./time"
import { postToSlack, type Poster, type SlackFireResult } from "./slack"

export interface PollFireEvent {
  txnId: string
  merchant: string
  amountDollars: number
  time: string
  ruleId: string
  description: string
  channel: string
  slack: SlackFireResult
}

let seen: Set<string> | null = null

function toTxLike(t: Transaction): TxLike {
  return {
    merchant: t.merchant,
    descriptor: t.descriptor,
    category: t.category,
    hour: pacificHour(t.timestamp),
    amountDollars: Math.round(Math.abs(t.amount)) / 100,
    direction: t.amount < 0 ? "debit" : "credit",
  }
}

function buildSnitch(t: Transaction, tx: TxLike): string {
  const amount = `$${tx.amountDollars.toFixed(2)}`
  const time = pacificTimeLabel(t.timestamp)
  return (
    `🚨 Late-night delivery alert: Yousef just ordered *${t.merchant}* (${amount}) at ${time}. ` +
    `He literally set up this alert to snitch on himself. Stage an intervention. 🌮🌙`
  )
}

export async function runPoll(poster: Poster = postToSlack): Promise<PollFireEvent[]> {
  const { data } = listTransactions({ limit: 50 })

  // First poll establishes the baseline; nothing fires retroactively.
  if (seen === null) {
    seen = new Set(data.map((t) => t.id))
    return []
  }

  const events: PollFireEvent[] = []
  for (const t of data) {
    if (seen.has(t.id)) continue
    seen.add(t.id)
    const tx = toTxLike(t)
    const matched: Rule[] = matchRules(tx)
    for (const rule of matched) {
      const slack = await poster(rule.channel, buildSnitch(t, tx))
      events.push({
        txnId: t.id,
        merchant: t.merchant,
        amountDollars: tx.amountDollars,
        time: pacificTimeLabel(t.timestamp),
        ruleId: rule.id,
        description: rule.description,
        channel: rule.channel,
        slack,
      })
    }
  }
  return events
}

/** Reset the baseline (used by the demo reset). */
export function resetPoller(): void {
  seen = null
}
