"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Reveal } from "@/components/ui/reveal"

// Minimal hand-drawn marks (stroke = currentColor), deliberately monochrome and
// abstract — no trademarked full-color logos in the product fiction.
const GLYPH_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const

function GmailGlyph() {
  return (
    <svg {...GLYPH_PROPS} width="22" height="22" aria-hidden>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="m4.5 7.5 7.5 5.5 7.5-5.5" />
    </svg>
  )
}

function DriveGlyph() {
  return (
    <svg {...GLYPH_PROPS} width="22" height="22" aria-hidden>
      <path d="M9.2 4.5h5.6L21 15.6l-2.9 4.4H5.9L3 15.6z" />
      <path d="M3 15.6h18" />
    </svg>
  )
}

function SharePointGlyph() {
  return (
    <svg {...GLYPH_PROPS} width="22" height="22" aria-hidden>
      <circle cx="9.5" cy="9" r="5" />
      <circle cx="15" cy="14.5" r="5" />
    </svg>
  )
}

function QuickBooksGlyph() {
  return (
    <svg {...GLYPH_PROPS} width="22" height="22" aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v9M9 10a3 3 0 0 0 0 6h1.5M15 14a3 3 0 0 0 0-6h-1.5" />
    </svg>
  )
}

const INTEGRATIONS = [
  {
    name: "Gmail",
    glyph: GmailGlyph,
    description: "Send document requests and reminders from your firm's own inbox.",
  },
  {
    name: "Google Drive",
    glyph: DriveGlyph,
    description: "File verified client documents straight into your Drive folder structure.",
  },
  {
    name: "SharePoint",
    glyph: SharePointGlyph,
    description: "Sync engagement workpapers with your firm's SharePoint document library.",
  },
  {
    name: "QuickBooks",
    glyph: QuickBooksGlyph,
    description: "Pull client books at review time so returns start from reconciled numbers.",
  },
] as const

export default function IntegrationsPage() {
  return (
    <div className="space-y-6">
      <Reveal delay={0}>
        <PageHeader
          title="Integrations"
          description="Connect Cadence to the tools your firm already runs on"
        />
      </Reveal>
      <Reveal delay={0.05}>
        <div className="grid grid-cols-2 gap-4">
          {INTEGRATIONS.map(integration => (
            <Card key={integration.name} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-surface text-ink-soft">
                  <integration.glyph />
                </span>
                <Badge dot>Available</Badge>
              </div>
              <p className="mt-3.5 text-[14px] font-semibold tracking-tight">{integration.name}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
                {integration.description}
              </p>
              <div className="mt-4 border-t border-line/70 pt-3.5">
                <Button disabled title="Available on this workspace soon">
                  Connect
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </Reveal>
      <Reveal delay={0.1}>
        <p className="text-[12px] text-ink-faint">
          Connections are workspace-wide and inherit each staff member&apos;s permissions.
        </p>
      </Reveal>
    </div>
  )
}
