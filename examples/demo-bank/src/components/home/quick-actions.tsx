"use client"
import { Remixable } from "@vendoai/ui/chrome"
import { useToast } from "@/components/ui/toast"
import { QuickActionsView } from "./quick-actions-view"

/**
 * Container for the quick-actions strip. The toast plumbing lives HERE, on
 * the host side of the fork boundary, and reaches the presentational view
 * through a function prop — plumbing a fork cannot carry, so the surface is
 * review-kind (2026-08-02 final shape): a remix shows the user nothing until
 * a host reviewer approves it, and the approved version then mounts natively
 * in the page.
 */
export function QuickActions() {
  const toast = useToast()
  return (
    <Remixable review>
      <QuickActionsView
        onAction={() =>
          toast({ title: "Demo only", description: "This action is presentational in the demo." })
        }
      />
    </Remixable>
  )
}
