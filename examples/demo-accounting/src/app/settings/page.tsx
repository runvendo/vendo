"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardHeader } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Reveal } from "@/components/ui/reveal"

// Firm settings are managed by the Cadence account owner; this workspace view
// is read-only for Maya's role, so every control renders disabled.

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-8 px-5 py-3.5">
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-[12px] text-ink-faint">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

function TextValue({ value, mono = false }: { value: string; mono?: boolean }) {
  return (
    <input
      readOnly
      disabled
      value={value}
      className={`h-8 w-64 rounded-lg border border-line bg-surface px-3 text-[12.5px] text-ink-soft ${
        mono ? "font-mono text-[11.5px]" : ""
      }`}
    />
  )
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span
      role="switch"
      aria-checked={on}
      aria-disabled
      className={`inline-flex h-5 w-9 items-center rounded-full px-0.5 opacity-70 ${
        on ? "justify-end bg-ink" : "justify-start bg-line-strong"
      }`}
    >
      <span className="h-4 w-4 rounded-full bg-white shadow-card" />
    </span>
  )
}

export default function SettingsPage() {
  return (
    <div className="max-w-3xl space-y-6">
      <Reveal delay={0}>
        <PageHeader
          title="Settings"
          description="Firm workspace settings for Hartwell & Associates"
          actions={
            <Button variant="primary" disabled title="Only the account owner can edit firm settings">
              Save changes
            </Button>
          }
        />
      </Reveal>

      <Reveal delay={0.05}>
        <Card className="overflow-hidden">
          <CardHeader title="Profile" action={<Badge>Owner managed</Badge>} />
          <div className="divide-y divide-line/60 border-t border-line/70">
            <Row label="Firm name">
              <TextValue value="Hartwell & Associates" />
            </Row>
            <Row label="Primary contact" hint="Where client replies and portal notices are sent">
              <TextValue value="office@hartwellassociates.com" />
            </Row>
            <Row label="Time zone" hint="Deadlines and reminders use this zone">
              <TextValue value="Pacific Time (US & Canada)" />
            </Row>
          </div>
        </Card>
      </Reveal>

      <Reveal delay={0.1}>
        <Card className="overflow-hidden">
          <CardHeader title="Notifications" />
          <div className="divide-y divide-line/60 border-t border-line/70">
            <Row label="Client upload alerts" hint="Notify the assignee the moment a document lands">
              <Toggle on />
            </Row>
            <Row label="Deadline reminders" hint="Escalate when a filing is 21 days out with documents missing">
              <Toggle on />
            </Row>
            <Row label="Daily digest" hint="Morning summary of outstanding documents across the firm">
              <Toggle on={false} />
            </Row>
          </div>
        </Card>
      </Reveal>

      <Reveal delay={0.15}>
        <Card className="overflow-hidden">
          <CardHeader title="Document templates" />
          <div className="divide-y divide-line/60 border-t border-line/70">
            <Row label="Individual return checklist" hint="W-2, 1099s, prior-year return, deduction receipts">
              <Badge variant="verified">Default</Badge>
            </Row>
            <Row label="S-Corp / C-Corp checklist" hint="Adds payroll summary and business bank statements">
              <Badge>Active</Badge>
            </Row>
            <Row label="Partnership checklist" hint="Adds K-1 prep items and partner distribution records">
              <Badge>Active</Badge>
            </Row>
          </div>
        </Card>
      </Reveal>

      <Reveal delay={0.2}>
        <Card className="overflow-hidden">
          <CardHeader title="Billing" />
          <div className="divide-y divide-line/60 border-t border-line/70">
            <Row label="Plan" hint="Billed annually">
              <span className="text-[13px] font-medium">Cadence Professional</span>
            </Row>
            <Row label="Seats" hint="Staff members with workspace access">
              <span className="text-[13px] text-ink-soft tabular-nums">4 of 5 used</span>
            </Row>
            <Row label="Next renewal">
              <span className="text-[13px] text-ink-soft tabular-nums">Jan 1, 2027</span>
            </Row>
          </div>
        </Card>
      </Reveal>
    </div>
  )
}
