"use client"
import * as React from "react"
import { Search, ChevronDown, Check } from "lucide-react"
import type { Category, TxStatus } from "@/server/types"
import { useAccounts } from "@/lib/hooks"
import { Button } from "@/components/ui/button"
import { Segmented } from "@/components/ui/segmented"
import {
  Dropdown, DropdownTrigger, DropdownContent, DropdownItem,
} from "@/components/ui/dropdown"
import { categoryLabel } from "@/components/charts/colors"
import { cn } from "@/lib/cn"

export type SortKey = "newest" | "oldest" | "amount"

export interface Filters {
  search: string
  category: Category | "all"
  accountId: string | "all"
  status: TxStatus | "all"
  sort: SortKey
}

export const DEFAULT_FILTERS: Filters = {
  search: "",
  category: "all",
  accountId: "all",
  status: "all",
  sort: "newest",
}

const CATEGORIES: Category[] = [
  "dining", "groceries", "coffee", "transport", "subscriptions",
  "shopping", "income", "transfer", "housing", "other",
]

const STATUSES: TxStatus[] = ["posted", "pending", "authorized"]

function FilterSelect<T extends string>({
  label, value, options, onSelect,
}: {
  label: string
  value: T
  options: { label: string; value: T }[]
  onSelect: (v: T) => void
}) {
  const current = options.find((o) => o.value === value)
  const active = value !== options[0]?.value
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <Button variant="secondary" size="sm" className={cn(active && "border-border-strong")}>
          <span className="text-muted">{label}</span>
          <span className="text-ink">{current?.label ?? "All"}</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted" />
        </Button>
      </DropdownTrigger>
      <DropdownContent align="start" className="max-h-[320px] overflow-auto">
        {options.map((o) => (
          <DropdownItem key={o.value} onSelect={() => onSelect(o.value)}>
            <span className="flex-1">{o.label}</span>
            {o.value === value && <Check className="h-3.5 w-3.5 text-ink" />}
          </DropdownItem>
        ))}
      </DropdownContent>
    </Dropdown>
  )
}

export function FiltersBar({
  value, onChange,
}: {
  value: Filters
  onChange: (f: Filters) => void
}) {
  const { data: accounts } = useAccounts()
  const [draft, setDraft] = React.useState(() => ({ search: value.search, source: value.search }))
  const text = draft.source === value.search ? draft.search : value.search
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const patch = (p: Partial<Filters>) => onChange({ ...value, ...p })

  const onText = (next: string) => {
    setDraft({ search: next, source: value.search })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => onChange({ ...value, search: next }), 250)
  }

  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const categoryOptions = [
    { label: "All categories", value: "all" as const },
    ...CATEGORIES.map((c) => ({ label: categoryLabel(c), value: c })),
  ]
  const accountOptions = [
    { label: "All accounts", value: "all" as const },
    ...(accounts ?? []).map((a) => ({ label: a.name, value: a.id })),
  ]
  const statusOptions = [
    { label: "All statuses", value: "all" as const },
    ...STATUSES.map((s) => ({ label: s.charAt(0).toUpperCase() + s.slice(1), value: s })),
  ]

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[220px] flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder="Search transactions"
          className="h-8 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-[13px] text-ink placeholder:text-muted outline-none transition-colors focus:border-border-strong"
        />
      </div>
      <FilterSelect
        label="Category"
        value={value.category}
        options={categoryOptions}
        onSelect={(v) => patch({ category: v })}
      />
      <FilterSelect
        label="Account"
        value={value.accountId}
        options={accountOptions}
        onSelect={(v) => patch({ accountId: v })}
      />
      <FilterSelect
        label="Status"
        value={value.status}
        options={statusOptions}
        onSelect={(v) => patch({ status: v })}
      />
      <Segmented<SortKey>
        options={[
          { label: "Newest", value: "newest" },
          { label: "Oldest", value: "oldest" },
          { label: "Amount", value: "amount" },
        ]}
        value={value.sort}
        onChange={(v) => patch({ sort: v })}
      />
    </div>
  )
}
