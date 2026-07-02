"use client"

/**
 * Surface #3 — the generative Flowlet slot on the Cadence dashboard. Empty, it
 * shows a ghost preview you click to describe a view; the agent builds it in
 * an overlay and you pin the result into this card. It runs in its own
 * isolated thread ("cadence-slot") so it never crosses wires with the Cmd+K
 * overlay or the assistant page.
 */
import { FlowletThemeProvider } from "@flowlet/components"
import { FlowletSlot } from "@flowlet/shell"
import { FlowletRoot } from "./FlowletRoot"

export function FlowletCard() {
  return (
    <section aria-label="Custom view" className="space-y-2">
      <FlowletRoot threadId="cadence-slot">
        <FlowletThemeProvider>
          <FlowletSlot
            flowletId="home-dashboard"
            emptyLabel="Design a view"
            greeting="What do you want to see here?"
            suggestions={[
              "Clients missing documents, as a table",
              "Document progress for every client",
              "A timeline of upcoming filing deadlines",
            ]}
          />
        </FlowletThemeProvider>
      </FlowletRoot>
    </section>
  )
}
