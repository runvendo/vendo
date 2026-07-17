"use client"

import { useEffect, useRef, useState } from "react"
import { MessageSquare, Send } from "lucide-react"
import useSWR, { useSWRConfig } from "swr"
import { Button } from "@/components/ui/button"
import { Card, CardHeader } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher, type Message } from "@/lib/api"
import { cn } from "@/lib/cn"
import { relativeTime } from "@/lib/format"

function Bubble({ message }: { message: Message }) {
  const firm = message.direction === "firm"
  return (
    <div className={cn("flex flex-col", firm ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed",
          firm
            ? "rounded-br-sm border border-line bg-line/60"
            : "rounded-bl-sm border border-line bg-surface",
        )}
      >
        {message.body}
      </div>
      <p className="mt-1 px-0.5 text-[11px] text-ink-faint">
        {message.author} · {relativeTime(message.sentAt)}
      </p>
    </div>
  )
}

function ThreadSkeleton() {
  return (
    <div className="space-y-4 border-t border-line/70 px-5 py-4">
      <Skeleton className="h-16 w-3/4 rounded-xl" />
      <Skeleton className="ml-auto h-12 w-2/3 rounded-xl" />
      <Skeleton className="h-12 w-3/5 rounded-xl" />
    </div>
  )
}

export function MessageThread({ clientId, contactName }: { clientId: string; contactName?: string }) {
  const { data, error, mutate } = useSWR<Message[]>(`/api/clients/${clientId}/messages`, fetcher)
  const { mutate: globalMutate } = useSWRConfig()
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [data?.length])

  async function send() {
    const body = draft.trim()
    if (!body || sending) return
    setSending(true)
    setSendError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      })
      if (!res.ok) throw new Error()
      setDraft("")
      await Promise.all([mutate(), globalMutate("/api/activity")])
    } catch {
      setSendError("Message didn't send. Try again.")
    } finally {
      setSending(false)
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Messages"
        action={
          data && (
            <span className="text-[12px] text-ink-faint tabular-nums">{data.length} in thread</span>
          )
        }
      />
      {error ? (
        <ErrorState title="Couldn't load messages" />
      ) : !data ? (
        <ThreadSkeleton />
      ) : (
        <>
          <div ref={scrollRef} className="max-h-[380px] space-y-4 overflow-y-auto border-t border-line/70 px-5 py-4">
            {data.length === 0 ? (
              <EmptyState
                icon={MessageSquare}
                title="No messages yet"
                description="Start the thread below — messages go to the client's portal."
                className="py-6"
              />
            ) : (
              data.map(m => <Bubble key={m.id} message={m} />)
            )}
          </div>
          <form
            className="border-t border-line/70 p-3"
            onSubmit={e => {
              e.preventDefault()
              void send()
            }}
          >
            <div className="flex items-end gap-2">
              <textarea
                rows={2}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                placeholder={contactName ? `Message ${contactName}…` : "Write a message…"}
                aria-label="Message"
                className="min-h-[60px] flex-1 resize-none rounded-lg border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-line-strong focus:bg-card focus:ring-2 focus:ring-line focus:outline-none"
              />
              <Button variant="primary" type="submit" disabled={!draft.trim() || sending} className="h-8 px-3">
                <Send size={13} strokeWidth={1.75} />
                Send
              </Button>
            </div>
            <div className="mt-1.5 flex items-center justify-between px-0.5 text-[11px] text-ink-faint">
              <span>Sending as Maya Alvarez · Hartwell &amp; Associates</span>
              {sendError && <span className="font-medium text-status-overdue">{sendError}</span>}
            </div>
          </form>
        </>
      )}
    </Card>
  )
}
