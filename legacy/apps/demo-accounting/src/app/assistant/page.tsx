"use client"

import { useState } from "react"
import { TrustScreen, VendoThread } from "@vendoai/shell"
import { VendoRoot } from "@/components/vendo/VendoRoot"

const SUGGESTIONS = [
  "Show Rivera Landscaping's missing documents as a checklist",
  "Compare document progress for every client in a table",
  "Send Marisol Rivera a reminder about the missing W-2, 1099-NEC, and receipts",
]

function PageSurface() {
  const [trustOpen, setTrustOpen] = useState(false)

  return (
    <div className="fl-page">
      <div className="fl-tabbar">
        <span className="fl-tab" aria-selected="true">Chat</span>
        <button
          type="button"
          className="fl-tab fl-tab-trust"
          aria-label="Trust — what Vendo can do"
          onClick={() => setTrustOpen(true)}
        >
          🛡
        </button>
      </div>
      <div className="fl-page-body">
        <div className="fl-page-pane">
          <VendoThread
            greeting="What do you want to see or do?"
            suggestions={SUGGESTIONS}
            heroComposer
          />
        </div>
      </div>
      {trustOpen && (
        <div className="fl-trust-overlay" role="presentation" onClick={() => setTrustOpen(false)}>
          <div onClick={(event) => event.stopPropagation()}>
            <TrustScreen onClose={() => setTrustOpen(false)} />
          </div>
        </div>
      )}
    </div>
  )
}

export default function AssistantPage() {
  return (
    <div
      style={{
        height: "calc(100dvh - 120px)",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <VendoRoot>
        <PageSurface />
      </VendoRoot>
    </div>
  )
}
