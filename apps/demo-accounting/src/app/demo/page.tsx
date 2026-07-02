"use client"

// Hidden demo control panel (not linked from the sidebar): resets the seeded
// state between takes and choreographs simulated client uploads. This page is
// crew tooling, not part of the Cadence product fiction.

import { useState } from "react"
import Link from "next/link"
import { ArrowUpRight, FileUp, Loader2, RotateCcw, TerminalSquare } from "lucide-react"
import useSWR, { useSWRConfig } from "swr"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardHeader } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Reveal } from "@/components/ui/reveal"
import { fetcher, type ClientSummary, type DocumentRequest } from "@/lib/api"
import { cn } from "@/lib/cn"

interface ResetMetrics {
  clientsMissingDocs: number
  documentsOutstanding: number
  documentsReceived: number
  documentsTotal: number
}

async function post(url: string, body?: unknown): Promise<{ ok: boolean; json: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  })
  return { ok: res.ok, json: await res.json().catch(() => null) }
}

const selectClass =
  "h-8 w-full rounded-lg border border-line bg-card px-2.5 text-[12.5px] text-ink focus:border-evergreen-400 focus:ring-2 focus:ring-evergreen-100 focus:outline-none disabled:opacity-55"

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="mb-1 block text-[11px] font-medium text-ink-faint">{children}</span>
}

function ResetSection() {
  const { mutate: globalMutate } = useSWRConfig()
  const [busy, setBusy] = useState(false)
  const [metrics, setMetrics] = useState<ResetMetrics | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function reset() {
    setBusy(true)
    setError(null)
    try {
      const { ok, json } = await post("/api/demo/reset")
      if (!ok) throw new Error("Reset failed")
      setMetrics((json as { data: ResetMetrics }).data)
      await globalMutate(() => true) // every open SWR view re-reads the restored store
    } catch (err) {
      setMetrics(null)
      setError(err instanceof Error ? err.message : "Reset failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader title="Reset demo data" />
      <div className="space-y-4 border-t border-line/70 px-5 py-4">
        <p className="text-[12.5px] leading-relaxed text-ink-soft">
          Restores the seeded opening state (8 clients missing documents, lived-in message
          history). Run between takes.
        </p>
        <Button variant="primary" onClick={reset} disabled={busy}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
          Reset to seed
        </Button>
        {error && (
          <p className="rounded-lg bg-status-overdue-bg px-3 py-2 text-[12px] text-status-overdue">
            {error}
          </p>
        )}
        {metrics && (
          <div className="rounded-lg border border-line bg-surface px-4 py-3">
            <p className="text-[11px] font-medium text-status-verified">Seed restored</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px] tabular-nums">
              {(
                [
                  ["Clients missing docs", metrics.clientsMissingDocs],
                  ["Documents outstanding", metrics.documentsOutstanding],
                  ["Documents received", metrics.documentsReceived],
                  ["Documents total", metrics.documentsTotal],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-4">
                  <dt className="text-ink-faint">{label}</dt>
                  <dd className="font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </Card>
  )
}

function SimulateSection() {
  const { mutate: globalMutate } = useSWRConfig()
  const { data: clients } = useSWR<ClientSummary[]>("/api/clients?filter=missing_docs", fetcher)
  const [selectedClientId, setSelectedClientId] = useState("")
  const [selectedDocId, setSelectedDocId] = useState("")
  const [variant, setVariant] = useState<"correct" | "wrong">("wrong")
  const [fileName, setFileName] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; body: string; clientId: string } | null>(null)

  // Selections self-heal as uploads land: a client that no longer has missing
  // docs drops out of the picker, and its docs list shrinks underneath us.
  const clientId = clients?.some(c => c.id === selectedClientId) ? selectedClientId : ""
  const { data: docs } = useSWR<DocumentRequest[]>(
    clientId ? `/api/clients/${clientId}/documents` : null,
    fetcher,
  )
  const missingDocs = docs?.filter(d => d.status === "missing")
  const docId = missingDocs?.some(d => d.id === selectedDocId) ? selectedDocId : ""

  async function fire() {
    if (!clientId || !docId) return
    setBusy(true)
    try {
      const { ok, json } = await post("/api/demo/simulate/upload", {
        clientId,
        docId,
        variant,
        ...(fileName.trim() ? { fileName: fileName.trim() } : {}),
      })
      setResult({ ok, body: JSON.stringify(json, null, 2), clientId })
      if (ok) await globalMutate(() => true)
    } catch (err) {
      setResult({ ok: false, body: err instanceof Error ? err.message : "Request failed", clientId })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader title="Simulate client upload" />
      <div className="space-y-4 border-t border-line/70 px-5 py-4">
        <p className="text-[12.5px] leading-relaxed text-ink-soft">
          A client &ldquo;uploads&rdquo; a file against one of their missing documents.{" "}
          <span className="font-medium">Wrong</span> lands it flagged for review with a note (the
          wrong-document catch); <span className="font-medium">correct</span> lands it as received.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <FieldLabel>Client (with missing documents)</FieldLabel>
            <select
              className={selectClass}
              value={clientId}
              onChange={e => {
                setSelectedClientId(e.target.value)
                setSelectedDocId("")
              }}
              disabled={!clients}
            >
              <option value="">{clients ? "Select a client…" : "Loading clients…"}</option>
              {clients?.map(c => (
                <option key={c.id} value={c.id}>
                  {c.businessName} ({c.progress.total - c.progress.received} missing)
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <FieldLabel>Missing document</FieldLabel>
            <select
              className={selectClass}
              value={docId}
              onChange={e => setSelectedDocId(e.target.value)}
              disabled={!clientId || !missingDocs}
            >
              <option value="">
                {!clientId ? "Pick a client first" : missingDocs ? "Select a document…" : "Loading…"}
              </option>
              {missingDocs?.map(d => (
                <option key={d.id} value={d.id}>
                  {d.kind}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>Variant</FieldLabel>
            <div className="flex rounded-lg border border-line p-0.5">
              {(["wrong", "correct"] as const).map(v => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVariant(v)}
                  className={cn(
                    "h-7 flex-1 rounded-md text-[12px] font-medium transition-colors",
                    variant === v ? "bg-evergreen-600 text-white" : "text-ink-soft hover:bg-surface",
                  )}
                >
                  {v === "wrong" ? "Wrong document" : "Correct document"}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <FieldLabel>File name (optional)</FieldLabel>
            <input
              value={fileName}
              onChange={e => setFileName(e.target.value)}
              placeholder={variant === "wrong" ? "personal-checking-statements-jan-jun.pdf" : "auto-generated from client and kind"}
              className={cn(selectClass, "font-mono text-[11.5px] placeholder:font-sans placeholder:text-[12px] placeholder:text-ink-faint")}
            />
          </label>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={fire} disabled={busy || !clientId || !docId}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />}
            Simulate upload
          </Button>
          {result?.ok && (
            <Link
              href={`/clients/${result.clientId}`}
              className="inline-flex items-center gap-1 text-[12.5px] font-medium text-evergreen-600 transition-colors hover:text-evergreen-800"
            >
              Open client detail
              <ArrowUpRight size={13} />
            </Link>
          )}
        </div>

        {result && (
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <FieldLabel>API response</FieldLabel>
              <Badge variant={result.ok ? "verified" : "overdue"} className="mb-1">
                {result.ok ? "200 OK" : "Error"}
              </Badge>
            </div>
            <pre className="max-h-64 overflow-auto rounded-lg bg-evergreen-950 px-4 py-3 font-mono text-[11px] leading-relaxed text-evergreen-100/90">
              {result.body}
            </pre>
          </div>
        )}
      </div>
    </Card>
  )
}

export default function DemoControlPage() {
  return (
    <div className="max-w-3xl space-y-6">
      <Reveal delay={0}>
        <PageHeader
          title="Demo controls"
          description="Not part of the Cadence product fiction — reset and choreograph the demo here."
          actions={
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-faint">
              <TerminalSquare size={12} strokeWidth={1.75} />
              Hidden page
            </span>
          }
        />
      </Reveal>
      <Reveal delay={0.05}>
        <ResetSection />
      </Reveal>
      <Reveal delay={0.1}>
        <SimulateSection />
      </Reveal>
    </div>
  )
}
