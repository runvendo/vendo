"use client"

import { useState } from "react"
import { AlertTriangle, FileStack, Loader2 } from "lucide-react"
import useSWR, { useSWRConfig } from "swr"
import { Badge, BADGE_VARIANTS } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardHeader } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher, type DocumentRequest } from "@/lib/api"
import { cn } from "@/lib/cn"
import { relativeTime } from "@/lib/format"
import { DOC_STATUS_META } from "./meta"

type DocAction = "receive" | "verify" | "reject"

function RejectForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean
  onSubmit: (reason: string) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState("")
  return (
    <form
      className="mt-2.5 flex items-center gap-2"
      onSubmit={e => {
        e.preventDefault()
        if (reason.trim()) onSubmit(reason.trim())
      }}
    >
      <input
        autoFocus
        value={reason}
        onChange={e => setReason(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Escape") onCancel()
        }}
        placeholder="Why is this going back? e.g. This is the personal account, not the business one"
        aria-label="Re-upload reason"
        className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-card px-3 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-evergreen-400 focus:ring-2 focus:ring-evergreen-100 focus:outline-none"
      />
      <Button variant="primary" type="submit" disabled={busy || !reason.trim()}>
        Send request
      </Button>
      <Button onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
    </form>
  )
}

function DocRow({
  doc,
  pending,
  rejecting,
  onAction,
  onStartReject,
  onCancelReject,
}: {
  doc: DocumentRequest
  pending: boolean
  rejecting: boolean
  onAction: (action: DocAction, reason?: string) => void
  onStartReject: () => void
  onCancelReject: () => void
}) {
  const meta = DOC_STATUS_META[doc.status]
  const reviewable = doc.status === "received" || doc.status === "needs_review"
  const flagged = doc.status === "needs_review"
  return (
    <li className={cn("px-5 py-3.5", flagged && "border-l-2 border-l-status-review bg-status-review-bg/30")}>
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
            BADGE_VARIANTS[meta.variant],
          )}
        >
          <meta.icon size={13} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-medium">{doc.kind}</span>
            <Badge variant={meta.variant}>{meta.label}</Badge>
          </div>
          {doc.file && (
            <p className="mt-1 truncate text-[12px] text-ink-faint">
              <span className="font-mono text-[11.5px] text-ink-soft">{doc.file.name}</span>
              {" · uploaded "}
              {relativeTime(doc.file.uploadedAt)}
            </p>
          )}
          {doc.note && (
            <div
              className={cn(
                "mt-2 flex items-start gap-2 rounded-lg px-3 py-2 text-[12px] leading-relaxed",
                flagged
                  ? "bg-status-review-bg font-medium text-status-review"
                  : "bg-status-missing-bg text-status-missing",
              )}
            >
              <AlertTriangle size={13} strokeWidth={1.75} className="mt-0.5 shrink-0" />
              <span>{doc.note}</span>
            </div>
          )}
          {rejecting && (
            <RejectForm busy={pending} onSubmit={reason => onAction("reject", reason)} onCancel={onCancelReject} />
          )}
        </div>
        {!rejecting && (
          <div className="flex shrink-0 items-center gap-1.5">
            {pending && <Loader2 size={14} className="animate-spin text-ink-faint" aria-hidden />}
            {doc.status === "missing" && (
              <Button onClick={() => onAction("receive")} disabled={pending}>
                Mark received
              </Button>
            )}
            {reviewable && (
              <>
                <Button variant="primary" onClick={() => onAction("verify")} disabled={pending}>
                  Verify &amp; file
                </Button>
                <Button onClick={onStartReject} disabled={pending}>
                  Request re-upload
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

function ChecklistSkeleton() {
  return (
    <div className="space-y-4 border-t border-line/70 px-5 py-4">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
          <div className="flex-1">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-1.5 h-3 w-56" />
          </div>
          <Skeleton className="h-7 w-24 rounded-md" />
        </div>
      ))}
    </div>
  )
}

export function DocumentChecklist({ clientId }: { clientId: string }) {
  const { data, error, mutate } = useSWR<DocumentRequest[]>(`/api/clients/${clientId}/documents`, fetcher)
  const { mutate: globalMutate } = useSWRConfig()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  async function act(docId: string, action: DocAction, reason?: string) {
    setPendingId(docId)
    setActionError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/documents/${docId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reason ? { action, reason } : { action }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
        throw new Error(json?.error?.message ?? "The update didn't go through. Try again.")
      }
      setRejectingId(prev => (prev === docId ? null : prev))
      // Progress, status, and the activity feed all derive from documents.
      await Promise.all([mutate(), globalMutate(`/api/clients/${clientId}`), globalMutate("/api/activity")])
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "The update didn't go through. Try again.")
    } finally {
      setPendingId(null)
    }
  }

  const verified = data?.filter(d => d.status === "verified").length

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Document checklist"
        action={
          data && (
            <span className="text-[12px] text-ink-faint tabular-nums">
              {verified} of {data.length} verified
            </span>
          )
        }
      />
      {actionError && (
        <p className="mx-5 mb-3 rounded-lg bg-status-overdue-bg px-3 py-2 text-[12px] text-status-overdue">
          {actionError}
        </p>
      )}
      {error ? (
        <ErrorState title="Couldn't load documents" />
      ) : !data ? (
        <ChecklistSkeleton />
      ) : data.length === 0 ? (
        <EmptyState
          icon={FileStack}
          title="No documents requested"
          description="Requested documents for this engagement will appear here."
        />
      ) : (
        <ul className="divide-y divide-line/60 border-t border-line/70">
          {data.map(doc => (
            <DocRow
              key={doc.id}
              doc={doc}
              pending={pendingId === doc.id}
              rejecting={rejectingId === doc.id}
              onAction={(action, reason) => act(doc.id, action, reason)}
              onStartReject={() => setRejectingId(doc.id)}
              onCancelReject={() => setRejectingId(null)}
            />
          ))}
        </ul>
      )}
    </Card>
  )
}
