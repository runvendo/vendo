"use client"
import { Building2 } from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { usePayees } from "@/lib/hooks"
import { BrandLogo } from "@/components/ui/brand-logo"
import { domainForName } from "@/lib/logos"
import type { Payee } from "@/server/types"

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
}

function caption(p: Payee) {
  const kind = p.kind === "person" ? "Person" : "Biller"
  return p.mask ? `${kind} · ${p.mask}` : kind
}

export function PayeesList() {
  const { data, isLoading } = usePayees()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payees</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {isLoading || !data
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 py-2.5">
                <Skeleton className="h-9 w-9 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            ))
          : data.map((p) => (
              <div key={p.id} className="flex items-center gap-3 rounded-lg py-2.5">
                <BrandLogo domain={domainForName(p.name)} alt={p.name} size={36} rounded="rounded-full"
                  fallback={
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-hover text-xs font-semibold text-ink-soft">
                      {p.kind === "biller" ? (
                        <Building2 className="h-4 w-4" strokeWidth={1.75} />
                      ) : (
                        initials(p.name)
                      )}
                    </span>
                  } />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">{p.name}</div>
                  <div className="truncate text-xs capitalize text-muted">{caption(p)}</div>
                </div>
              </div>
            ))}
      </CardContent>
    </Card>
  )
}
