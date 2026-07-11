"use client"

import { useState } from "react"
import { TrustScreen, VendoThread } from "@vendoai/shell"
import { VendoRoot } from "@/components/vendo/VendoRoot"

const SUGGESTIONS = [
  "Which clients are still missing documents?",
  "Show me everyone within two weeks of their filing deadline",
]

function PageSurface() {
  const [trustOpen, setTrustOpen] = useState(false)

  return (
    <div className="fl-page">
      <div className="fl-tabbar">
        <span className="fl-tab" aria-current="page">Chat</span>
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
            greeting="What do you want to build?"
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
