"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Reveal } from "@/components/ui/reveal"

import { logoUrl } from "@/lib/logos"

// Real product logos via the shared favicon mechanism (see src/lib/logos.ts).
// Gmail, Google Calendar, and Slack are genuinely wired through the Vendo
// Composio connector, so they read as connected.
const INTEGRATIONS = [
  {
    name: "Gmail",
    domain: "gmail.com",
    connected: true,
    description: "Send document requests and reminders from your firm's own inbox.",
  },
  {
    name: "Google Calendar",
    domain: "calendar.google.com",
    connected: true,
    description: "Filing deadlines and client meetings, mirrored to the firm calendar.",
  },
  {
    name: "Slack",
    domain: "slack.com",
    connected: true,
    description: "Firm notifications in your team's channels the moment things change.",
  },
  {
    name: "Google Drive",
    domain: "drive.google.com",
    connected: false,
    description: "File verified client documents straight into your Drive folder structure.",
  },
  {
    name: "QuickBooks",
    domain: "quickbooks.intuit.com",
    connected: false,
    description: "Pull client books at review time so returns start from reconciled numbers.",
  },
  {
    name: "SharePoint",
    domain: "sharepoint.com",
    connected: false,
    description: "Sync engagement workpapers with your firm's SharePoint document library.",
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
                <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-white">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={logoUrl(integration.domain, 64)}
                    alt=""
                    loading="lazy"
                    className="h-5.5 w-5.5 object-contain"
                  />
                </span>
                {integration.connected ? (
                  <Badge variant="verified" dot>
                    Connected
                  </Badge>
                ) : (
                  <Badge dot>Available</Badge>
                )}
              </div>
              <p className="mt-3.5 text-[14px] font-semibold tracking-tight">{integration.name}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
                {integration.description}
              </p>
              <div className="mt-4 border-t border-line/70 pt-3.5">
                <Button disabled title={integration.connected ? "Managed by your workspace" : "Available on this workspace soon"}>
                  {integration.connected ? "Manage" : "Connect"}
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
