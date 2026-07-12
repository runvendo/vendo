"use client"
import { FileText, Download } from "lucide-react"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"

function lastMonths(count: number) {
  const now = new Date()
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric" })
  })
}

export function StatementsList() {
  const toast = useToast()
  const months = lastMonths(6)

  const onDownload = () =>
    toast({ title: "Demo only", description: "Statements aren't generated in the demo." })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Statements &amp; documents</CardTitle>
      </CardHeader>
      <div className="divide-y divide-border border-t border-border">
        {months.map((label) => (
          <div key={label} className="flex items-center gap-3 px-5 py-3.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-border bg-hover text-muted">
              <FileText className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-ink">{label} statement</div>
              <div className="text-xs text-muted">PDF · 1–2 pages</div>
            </div>
            <Button variant="ghost" size="sm" onClick={onDownload}>
              <Download className="h-4 w-4" />
              Download
            </Button>
          </div>
        ))}
      </div>
    </Card>
  )
}
