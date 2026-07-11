"use client"

import { VendoThread } from "@vendoai/shell"
import { VendoRoot } from "@/components/vendo/VendoRoot"
import { mapleRealtimeVoiceDriver } from "@/components/vendo/voice-realtime"

const SUGGESTIONS = [
  "What did I spend money on when I should've been asleep?",
  "What was that $87 DoorDash charge?",
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
          greeting="What do you want to build?"
          suggestions={SUGGESTIONS}
          heroComposer
          voice={mapleRealtimeVoiceDriver}
        />
      </VendoRoot>
    </div>
  )
}
