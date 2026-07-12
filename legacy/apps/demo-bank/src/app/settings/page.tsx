"use client"
import * as React from "react"
import { Bell, Lock, Mail, Globe, Moon } from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Segmented } from "@/components/ui/segmented"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/components/ui/toast"
import { useProfile } from "@/lib/hooks"
import { BrandLogo } from "@/components/ui/brand-logo"
import { domainForName } from "@/lib/logos"

function SettingRow({
  icon: Icon,
  leading,
  label,
  description,
  children,
}: {
  icon?: React.ComponentType<{ className?: string; strokeWidth?: number }>
  leading?: React.ReactNode
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3.5">
      <div className="flex min-w-0 items-start gap-3">
        {leading
          ? leading
          : Icon && (
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-border bg-hover text-ink-soft">
                <Icon className="h-4 w-4" strokeWidth={1.75} />
              </span>
            )}
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink">{label}</div>
          {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

function ProfileCard() {
  const { data, isLoading } = useProfile()
  const toast = useToast()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            {isLoading || !data ? (
              <>
                <Skeleton className="h-12 w-12 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-44" />
                </div>
              </>
            ) : (
              <>
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ink text-sm font-semibold text-white">
                  {data.avatarInitials}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-ink">{data.name}</div>
                  <div className="truncate text-xs text-muted">{data.email}</div>
                </div>
              </>
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => toast({ title: "Demo only", description: "Profile editing is presentational." })}
          >
            Edit profile
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function ToggleSection({
  title,
  rows,
}: {
  title: string
  rows: {
    key: string
    icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
    label: string
    description: string
    defaultOn: boolean
  }[]
}) {
  const toast = useToast()
  const [state, setState] = React.useState<Record<string, boolean>>(
    () => Object.fromEntries(rows.map((r) => [r.key, r.defaultOn])),
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="divide-y divide-border py-0">
        {rows.map((r) => (
          <SettingRow key={r.key} icon={r.icon} label={r.label} description={r.description}>
            <Switch
              checked={state[r.key]}
              onCheckedChange={(v) => {
                setState((s) => ({ ...s, [r.key]: v }))
                toast({ title: "Setting updated", description: "Demo only." })
              }}
            />
          </SettingRow>
        ))}
      </CardContent>
    </Card>
  )
}

function PreferencesCard() {
  const toast = useToast()
  const [email, setEmail] = React.useState(true)
  const [push, setPush] = React.useState(true)
  const [theme, setTheme] = React.useState<"light" | "system">("light")
  const updated = () => toast({ title: "Setting updated", description: "Demo only." })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Preferences</CardTitle>
      </CardHeader>
      <CardContent className="divide-y divide-border py-0">
        <SettingRow icon={Mail} label="Email notifications" description="Receipts, statements, and alerts.">
          <Switch
            checked={email}
            onCheckedChange={(v) => {
              setEmail(v)
              updated()
            }}
          />
        </SettingRow>
        <SettingRow icon={Bell} label="Push notifications" description="Real-time activity on your devices.">
          <Switch
            checked={push}
            onCheckedChange={(v) => {
              setPush(v)
              updated()
            }}
          />
        </SettingRow>
        <SettingRow icon={Moon} label="Theme" description="Appearance across the app.">
          <Segmented
            options={[
              { label: "Light", value: "light" },
              { label: "System", value: "system" },
            ]}
            value={theme}
            onChange={(v) => {
              setTheme(v)
              updated()
            }}
          />
        </SettingRow>
      </CardContent>
    </Card>
  )
}

const LINKED = [
  { name: "Chase", detail: "·· 1185" },
  { name: "Venmo", detail: "Connected" },
  { name: "Apple Pay", detail: "Connected" },
]

function LinkedAccountsCard() {
  const toast = useToast()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Linked accounts</CardTitle>
      </CardHeader>
      <CardContent className="divide-y divide-border py-0">
        {LINKED.map((l) => (
          <SettingRow
            key={l.name}
            label={l.name}
            description={l.detail}
            leading={
              <BrandLogo
                domain={domainForName(l.name)}
                alt={l.name}
                size={32}
                className="mt-0.5"
                fallback={
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-border bg-hover text-ink-soft">
                    <Globe className="h-4 w-4" strokeWidth={1.75} />
                  </span>
                }
              />
            }
          >
            <button
              className="text-sm font-medium text-ink-soft transition-colors hover:text-ink"
              onClick={() => toast({ title: "Demo only", description: "Linked accounts are presentational." })}
            >
              Manage
            </button>
          </SettingRow>
        ))}
      </CardContent>
    </Card>
  )
}

function DangerZoneCard() {
  const toast = useToast()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Danger zone</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-ink">Close account</div>
            <div className="mt-0.5 text-xs text-muted">Permanently close your Maple account.</div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-neg hover:bg-neg-bg"
            onClick={() => toast({ title: "Demo only", description: "No accounts can be closed in the demo." })}
          >
            Close account
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Settings</h1>
        <p className="text-sm text-muted">Manage your profile, security, and preferences.</p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-6 lg:col-span-2">
          <ProfileCard />
        </div>

        <ToggleSection
          title="Security"
          rows={[
            { key: "2fa", icon: Lock, label: "Two-factor authentication", description: "Require a code at sign-in.", defaultOn: true },
            { key: "biometric", icon: Lock, label: "Biometric login", description: "Use Face ID or Touch ID.", defaultOn: true },
            { key: "pin", icon: Lock, label: "Require PIN for transfers", description: "Confirm a PIN before moving money.", defaultOn: false },
          ]}
        />
        <PreferencesCard />
        <LinkedAccountsCard />
        <DangerZoneCard />
      </div>
    </div>
  )
}
