"use client"

/**
 * The generative Vendo slot on the Maple dashboard. Empty, it shows a ghost
 * preview you click to describe a view; the agent renders it in an overlay.
 * It runs in its own isolated thread
 * ("maple-slot") so it never crosses wires with the floating dock/overlay.
 */
import { VendoThemeProvider } from "@vendoai/components"
import { VendoSlot } from "@vendoai/shell"
import { VendoRoot } from "@/components/vendo/VendoRoot"
import { mapleRealtimeVoiceDriver } from "@/components/vendo/voice-realtime"

export function VendoCard() {
  return (
    <section aria-label="Custom view" className="space-y-2">
      <VendoRoot threadId="maple-slot">
        <VendoThemeProvider>
          <VendoSlot
            vendoId="home-dashboard"
            emptyLabel="Design a view"
            greeting="What do you want to see here?"
            voice={mapleRealtimeVoiceDriver}
            suggestions={[
              "My spending by category this month",
              "A chart of my net worth over time",
              "My recent transactions as a table",
            ]}
          />
        </VendoThemeProvider>
      </VendoRoot>
    </section>
  )
}
