"use client"
import * as React from "react"
import { ChevronDown, Send, Download, ArrowLeftRight, Receipt } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Dropdown, DropdownTrigger, DropdownContent, DropdownItem } from "@/components/ui/dropdown"
import { useToast } from "@/components/ui/toast"
import { usePayees, useAccounts } from "@/lib/hooks"
import { formatUSD } from "@/lib/money"
import { cn } from "@/lib/cn"

type Option = { value: string; label: string; caption?: string }

const demoToast = { title: "Demo only", description: "No real money moves in the demo." }

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted">{label}</label>
      {children}
    </div>
  )
}

function AmountField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const sanitize = (raw: string) => {
    const cleaned = raw.replace(/[^0-9.]/g, "")
    const parts = cleaned.split(".")
    const merged = parts.length > 1 ? `${parts[0]}.${parts.slice(1).join("").slice(0, 2)}` : parts[0]
    return merged
  }
  return (
    <Field label="Amount">
      <div className="relative">
        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-2xl font-semibold text-muted">$</span>
        <input
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(sanitize(e.target.value))}
          placeholder="0.00"
          className="w-full rounded-xl border border-border bg-surface py-4 pl-10 pr-4 text-3xl font-semibold tabular-nums tracking-tight text-ink outline-none transition-colors focus:border-ink/30"
        />
      </div>
    </Field>
  )
}

function SelectField({
  label,
  value,
  placeholder,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  options: Option[]
  disabled?: boolean
  onChange: (v: string) => void
}) {
  const selected = options.find((o) => o.value === value)
  return (
    <Field label={label}>
      <Dropdown>
        <DropdownTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="flex h-11 w-full items-center justify-between rounded-xl border border-border bg-surface px-3.5 text-sm outline-none transition-colors hover:bg-hover disabled:opacity-50 disabled:pointer-events-none"
          >
            <span className="flex min-w-0 flex-col items-start">
              <span className={cn("truncate", selected ? "text-ink" : "text-muted")}>
                {disabled ? "Loading…" : (selected?.label ?? placeholder)}
              </span>
              {selected?.caption && (
                <span className="truncate text-xs tabular-nums text-muted">{selected.caption}</span>
              )}
            </span>
            <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-muted" />
          </button>
        </DropdownTrigger>
        <DropdownContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
          {options.map((o) => (
            <DropdownItem key={o.value} onSelect={() => onChange(o.value)} className="flex-col items-start gap-0">
              <span className="text-ink">{o.label}</span>
              {o.caption && <span className="text-xs tabular-nums text-muted">{o.caption}</span>}
            </DropdownItem>
          ))}
        </DropdownContent>
      </Dropdown>
    </Field>
  )
}

function NoteField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Note (optional)">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="What's it for?"
        className="h-11 w-full rounded-xl border border-border bg-surface px-3.5 text-sm text-ink outline-none transition-colors placeholder:text-muted focus:border-ink/30"
      />
    </Field>
  )
}

function FormCard({ children, onSubmit }: { children: React.ReactNode; onSubmit: () => void }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit()
          }}
        >
          {children}
        </form>
      </CardContent>
    </Card>
  )
}

function SendForm() {
  const toast = useToast()
  const { data: payees, isLoading } = usePayees()
  const people = (payees ?? []).filter((p) => p.kind === "person")
  const [amount, setAmount] = React.useState("")
  const [payee, setPayee] = React.useState("")
  const [note, setNote] = React.useState("")

  return (
    <FormCard onSubmit={() => toast(demoToast)}>
      <AmountField value={amount} onChange={setAmount} />
      <SelectField
        label="To"
        value={payee}
        placeholder="Select a person"
        disabled={isLoading}
        options={people.map((p) => ({ value: p.id, label: p.name, caption: p.mask }))}
        onChange={setPayee}
      />
      <NoteField value={note} onChange={setNote} />
      <Button type="submit" className="w-full">
        <Send className="h-4 w-4" />
        Review payment
      </Button>
    </FormCard>
  )
}

function RequestForm() {
  const toast = useToast()
  const { data: payees, isLoading } = usePayees()
  const people = (payees ?? []).filter((p) => p.kind === "person")
  const [amount, setAmount] = React.useState("")
  const [payee, setPayee] = React.useState("")
  const [note, setNote] = React.useState("")

  return (
    <FormCard onSubmit={() => toast(demoToast)}>
      <AmountField value={amount} onChange={setAmount} />
      <SelectField
        label="From"
        value={payee}
        placeholder="Select a person"
        disabled={isLoading}
        options={people.map((p) => ({ value: p.id, label: p.name, caption: p.mask }))}
        onChange={setPayee}
      />
      <NoteField value={note} onChange={setNote} />
      <Button type="submit" className="w-full">
        <Download className="h-4 w-4" />
        Send request
      </Button>
    </FormCard>
  )
}

function TransferForm() {
  const toast = useToast()
  const { data: accounts, isLoading } = useAccounts()
  const list = accounts ?? []
  const [amount, setAmount] = React.useState("")
  const [from, setFrom] = React.useState("")
  const [to, setTo] = React.useState("")

  const options: Option[] = list.map((a) => ({
    value: a.id,
    label: a.name,
    caption: formatUSD(a.balance),
  }))
  const sameAccount = !!from && from === to

  return (
    <FormCard onSubmit={() => toast(demoToast)}>
      <AmountField value={amount} onChange={setAmount} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SelectField
          label="From"
          value={from}
          placeholder="Source account"
          disabled={isLoading}
          options={options}
          onChange={setFrom}
        />
        <SelectField
          label="To"
          value={to}
          placeholder="Destination account"
          disabled={isLoading}
          options={options}
          onChange={setTo}
        />
      </div>
      {sameAccount && (
        <p className="text-xs text-neg">Choose two different accounts to transfer between.</p>
      )}
      <Button type="submit" className="w-full" disabled={sameAccount}>
        <ArrowLeftRight className="h-4 w-4" />
        Transfer
      </Button>
    </FormCard>
  )
}

function PayBillsForm() {
  const toast = useToast()
  const { data: payees, isLoading } = usePayees()
  const billers = (payees ?? []).filter((p) => p.kind === "biller")
  const [amount, setAmount] = React.useState("")
  const [biller, setBiller] = React.useState("")

  return (
    <FormCard onSubmit={() => toast(demoToast)}>
      <AmountField value={amount} onChange={setAmount} />
      <SelectField
        label="Biller"
        value={biller}
        placeholder="Select a biller"
        disabled={isLoading}
        options={billers.map((p) => ({ value: p.id, label: p.name, caption: p.mask }))}
        onChange={setBiller}
      />
      <Button type="submit" className="w-full">
        <Receipt className="h-4 w-4" />
        Schedule payment
      </Button>
    </FormCard>
  )
}

export function MoveMoneyTabs() {
  return (
    <Tabs defaultValue="send" className="space-y-4">
      <TabsList>
        <TabsTrigger value="send">Send</TabsTrigger>
        <TabsTrigger value="request">Request</TabsTrigger>
        <TabsTrigger value="transfer">Transfer</TabsTrigger>
        <TabsTrigger value="bills">Pay bills</TabsTrigger>
      </TabsList>
      <TabsContent value="send">
        <SendForm />
      </TabsContent>
      <TabsContent value="request">
        <RequestForm />
      </TabsContent>
      <TabsContent value="transfer">
        <TransferForm />
      </TabsContent>
      <TabsContent value="bills">
        <PayBillsForm />
      </TabsContent>
    </Tabs>
  )
}
