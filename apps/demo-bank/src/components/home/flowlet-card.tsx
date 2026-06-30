"use client"

/**
 * A dashboard tile rendered with the real @flowlet/components Card — the same
 * prewired component the agent generates into the thread. It showcases the
 * Flowlet component library living natively in the product surface (not the
 * late-night reveal — that stays for the live demo).
 */
import type { UINode } from "@flowlet/core"
import { FlowletThemeProvider } from "@flowlet/components"
import { renderNode } from "@/components/flowlet/render-node"

const SNAPSHOT: UINode = {
  id: "home-flowlet-snapshot",
  kind: "component",
  source: "prewired",
  name: "Card",
  props: {
    title: "This month at a glance",
    subtitle: "Spending vs. your typical month",
    iconName: "wallet",
    body:
      "$4,210 spent so far, about 12% under a typical month. Dining and groceries lead, " +
      "and your subscriptions held flat.",
    tags: ["Dining", "Groceries", "Subscriptions"],
  },
}

export function FlowletCard() {
  return (
    <section aria-label="Flowlet insight" className="space-y-2">
      <div className="flex items-center gap-1.5 px-0.5 text-xs font-medium text-muted">
        <span className="inline-flex h-1.5 w-1.5 rounded-full bg-pos" aria-hidden />
        Flowlet
      </div>
      <FlowletThemeProvider>{renderNode(SNAPSHOT)}</FlowletThemeProvider>
    </section>
  )
}
