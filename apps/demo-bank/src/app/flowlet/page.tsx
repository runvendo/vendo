"use client"

/**
 * Surface #2 — the full-page Flowlet tab. A proof point that the same agent
 * lives anywhere it's dropped, here as a dedicated page. It has its own thread
 * (the live demo path is the home dock + Cmd+K overlay, which share a thread);
 * the floating dock is hidden on this route (see FlowletLayer).
 */
import { FlowletThread } from "@flowlet/shell"
import { FlowletRoot } from "@/components/flowlet/FlowletRoot"

const SUGGESTIONS = [
  "What did I spend money on when I should've been asleep?",
  "What was that $87 DoorDash charge?",
  "Put me on blast in Slack when I order late-night delivery",
]

export default function FlowletTabPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Flowlet</h1>
        <p className="text-sm text-muted">Ask for anything. If Maple has no screen for it, Flowlet builds one.</p>
      </div>
      <div style={{ height: "calc(100vh - 220px)", minHeight: 420, display: "flex", flexDirection: "column" }}>
        <FlowletRoot>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflow: "hidden",
              borderRadius: 16,
              border: "1px solid #ECEBE8",
              background: "#fff",
              boxShadow: "0 14px 38px rgba(27,30,37,.08)",
            }}
          >
            <FlowletThread greeting="What do you want to build?" suggestions={SUGGESTIONS} />
          </div>
        </FlowletRoot>
      </div>
    </div>
  )
}
