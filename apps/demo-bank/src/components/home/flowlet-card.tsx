"use client"

/**
 * The generative Flowlet slot on the Maple dashboard. Empty, it shows a ghost
 * preview you click to describe a view; the agent builds it in an overlay and
 * you pin the result into this card. It runs in its own isolated thread
 * ("maple-slot") so it never crosses wires with the floating dock/overlay.
 */
import { FlowletThemeProvider } from "@flowlet/components"
import { FlowletSlot } from "@flowlet/shell"
import { FlowletRoot } from "@/components/flowlet/FlowletRoot"

export function FlowletCard() {
  return (
    <section aria-label="Custom view" className="space-y-2">
      <FlowletRoot threadId="maple-slot">
        <FlowletThemeProvider>
          <FlowletSlot flowletId="home-dashboard" emptyLabel="Design a view" />
        </FlowletThemeProvider>
      </FlowletRoot>
    </section>
  )
}
