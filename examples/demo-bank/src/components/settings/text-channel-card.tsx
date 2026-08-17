"use client"
import * as React from "react"
import { ArrowUpRight, MessageSquareText, X } from "lucide-react"
import qrcode from "qrcode-generator"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { MapleMark } from "@/components/ui/maple-mark"
import { Skeleton } from "@/components/ui/skeleton"
import { useTextLink } from "@/lib/hooks"

/** How long the dismissal takes — the longest exit leg in globals.css (the
 *  backdrop's fade). The dialog is closed once that has played. */
const EXIT_MS = 180

/** The invite link as a scannable code. Rendered as ONE path of unit squares in
 *  a module-sized viewBox, so it scales to any plate size without resampling.
 *  A QR is a contrast contract, not decoration — the modules are pinned to ink
 *  on a white plate rather than inheriting the surface. */
function QrCode({ value, className }: { value: string; className?: string }) {
  const { d, modules } = React.useMemo(() => {
    const qr = qrcode(0, "M")
    qr.addData(value)
    qr.make()
    const modules = qr.getModuleCount()
    let d = ""
    for (let row = 0; row < modules; row += 1) {
      for (let col = 0; col < modules; col += 1) {
        if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`
      }
    }
    return { d, modules }
  }, [value])

  return (
    <svg
      viewBox={`0 0 ${modules} ${modules}`}
      className={className}
      role="img"
      aria-label="QR code that opens the first text on your phone"
      shapeRendering="crispEdges"
    >
      <path d={d} fill="#111111" />
    </svg>
  )
}

/**
 * THE TEXT-CHANNEL OPT-IN on /settings.
 *
 * The card is the invitation; the modal is the nicer desktop version of the
 * door's own link page (`/api/vendo/channels/text/link`, which still serves
 * phones a 302 straight into Messages). Nothing is minted until the modal
 * opens — see useTextLink.
 *
 * The modal is a native `<dialog>`, so Esc, focus containment and the top layer
 * come from the platform rather than from a library — and its own `[open]` is
 * the one source of truth for whether it is up, which is why the handlers drive
 * `showModal()`/`close()` directly instead of mirroring that in React state.
 */
export function TextChannelCard() {
  const dialog = React.useRef<HTMLDialogElement>(null)
  // Sticky: once asked for, the invite stays fetched. It has to survive the
  // close animation (the QR must not blink out from under it), and SWR then
  // answers a re-open from cache — which matters here, because every mint
  // replaces the user's outstanding code.
  const [requested, setRequested] = React.useState(false)
  const [closing, setClosing] = React.useState(false)
  const { data, error, isLoading, mutate } = useTextLink(requested)

  const url = data?.url ?? null
  // Only an ANSWERED request can say "no channel here" — until then the plate
  // waits, so opening the modal never flashes an apology it is about to retract.
  const unavailable = data !== undefined && data.url === null
  // An outage is NOT the same answer as "no channel here": the first is passing
  // and worth another try, the second is permanent. Without this the dialog sits
  // on its skeleton for good, because nothing revalidates a failed request.
  const failed = error !== undefined && data === undefined

  const open = (): void => {
    setRequested(true)
    setClosing(false)
    dialog.current?.showModal()
  }

  // Dismissal takes two beats: the panel animates out under `data-closing`, and
  // only then does the dialog close — `close()` drops it out of the top layer at
  // once, which would cut the animation off at its first frame.
  const close = (): void => {
    setClosing(true)
    window.setTimeout(() => {
      dialog.current?.close()
      setClosing(false)
    }, EXIT_MS)
  }

  return (
    <Card className="bg-gradient-to-b from-surface to-hover/60">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Text channel</CardTitle>
          <Badge>New</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {/* The CTA drops under the copy on a narrow screen: held on one row it
            squeezes the description into a ribbon a few words wide. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
          <div className="flex min-w-0 items-start gap-3.5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-ink text-white">
              <MessageSquareText className="h-[18px] w-[18px]" strokeWidth={1.9} />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-ink">Text with Maple</div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                Ask Maple from your phone&rsquo;s Messages app. One text links it — no app to
                install.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={open}
            className="w-full shrink-0 transition-[background-color,transform] duration-150 active:scale-[0.97] sm:w-auto"
          >
            Set up texting
          </Button>
        </div>
      </CardContent>

      {/* Inside the card so the component is ONE box: a `space-y-*` stack in
          Tailwind v4 margins every child but the last, and a display:none
          sibling at the end would leave that margin behind as a phantom gap.
          `showModal()` promotes the dialog to the top layer, so where it sits in
          the DOM has no bearing on how it paints. */}
      <dialog
        ref={dialog}
        className="maple-modal m-auto w-[calc(100%-2rem)] max-w-[25rem] border-0 bg-transparent p-0"
        aria-labelledby="text-channel-title"
        data-closing={closing || undefined}
        // Esc goes through the same two beats as every other dismissal; left to
        // the platform it would close the dialog instantly, mid-animation.
        onCancel={(event) => {
          event.preventDefault()
          close()
        }}
        // The backdrop is the dialog's own hit area, so a click that lands on the
        // dialog rather than on the panel inside it is a click outside.
        onClick={(event) => {
          if (event.target === dialog.current) close()
        }}
      >
        <div className="maple-modal-panel relative rounded-card border border-border bg-surface p-6 text-left shadow-[0_1px_3px_rgba(17,17,17,.08),0_24px_60px_-20px_rgba(17,17,17,.28)]">
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="absolute right-3.5 top-3.5 flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-[color,background-color,transform] duration-150 hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15 active:scale-95"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>

          <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-ink text-white">
            <MapleMark className="h-[18px] w-[18px]" />
          </span>
          <h2 id="text-channel-title" className="mt-4 text-lg font-semibold tracking-tight text-ink">
            Maple, in your Messages
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
            Ask Maple anything by text — it answers as you, exactly as it does here.
          </p>

          {failed ? (
            <div className="mt-5 rounded-xl bg-hover px-4 py-3">
              <p className="text-xs leading-relaxed text-muted">
                Couldn&rsquo;t reach Maple&rsquo;s texting service just now.
              </p>
              <button
                type="button"
                onClick={() => void mutate()}
                disabled={isLoading}
                className="mt-2.5 inline-flex h-8 items-center justify-center rounded-lg border border-border bg-surface px-3 text-xs font-medium text-ink transition-[background-color,transform] duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15 active:scale-95 disabled:opacity-60"
              >
                {isLoading ? "Trying…" : "Try again"}
              </button>
            </div>
          ) : unavailable ? (
            <p className="mt-5 rounded-xl bg-hover px-4 py-3 text-xs leading-relaxed text-muted">
              Texting isn&rsquo;t switched on for this deployment yet, so there&rsquo;s no number to
              hand you.
            </p>
          ) : (
            <>
              <a
                href={url ?? undefined}
                aria-disabled={url === null}
                className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-ink bg-ink text-sm font-medium text-white transition-[background-color,transform] duration-150 hover:bg-ink/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/15 focus-visible:ring-offset-1 active:scale-[0.985] aria-disabled:pointer-events-none aria-disabled:opacity-50"
              >
                Open Messages
                <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
              </a>

              <div className="my-5 flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                  or scan from your phone
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>

              <div className="flex justify-center">
                <div className="rounded-xl border border-border bg-white p-3 shadow-[0_1px_2px_rgba(17,17,17,.05)]">
                  <div className="h-[152px] w-[152px]">
                    {url === null ? (
                      <Skeleton className="h-full w-full" />
                    ) : (
                      // Fades in when the code lands, so the plate settles
                      // instead of the QR popping into the skeleton's hole.
                      <QrCode value={url} className="block h-full w-full animate-fade-in" />
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {failed ? null : (
          <p className="mt-5 text-xs leading-relaxed text-muted">
            One text links your phone — send it as it is; the code is already inside and lasts 30
            minutes. A contact card called Maple comes back: text that from then on.
          </p>
          )}
        </div>
      </dialog>
    </Card>
  )
}
