"use client"

import { VendoThread } from "@vendoai/shell"
import { VendoRoot } from "@/components/vendo/VendoRoot"
import { mapleRealtimeVoiceDriver } from "@/components/vendo/voice-realtime"

const SUGGESTIONS = [
  "Show my late-night spending as a chart",
  "What was that $87 DoorDash charge?",
  "Send Jordan Avery $87 for dinner",
]

export default function VendoTabPage() {
  return (
    <div
      style={{
        height: "calc(100dvh - 112px)",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <VendoRoot>
        <VendoThread
          greeting="What do you want to see or do?"
          suggestions={SUGGESTIONS}
          heroComposer
          voice={mapleRealtimeVoiceDriver}
        />
      </VendoRoot>
    </div>
  )
}
