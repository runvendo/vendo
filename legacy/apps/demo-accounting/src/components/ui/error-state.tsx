import { AlertCircle } from "lucide-react"
import { cn } from "@/lib/cn"
import { EmptyState } from "./empty-state"

/** Shared SWR-error treatment: compact, non-alarming, sits inside a Card. */
export function ErrorState({
  title = "Couldn't load this data",
  description = "Something went wrong talking to the server. Refresh the page to try again.",
  className,
}: {
  title?: string
  description?: string
  className?: string
}) {
  return (
    <EmptyState
      icon={AlertCircle}
      iconClassName="border-transparent bg-status-overdue-bg text-status-overdue"
      title={title}
      description={description}
      className={cn("py-10", className)}
    />
  )
}
