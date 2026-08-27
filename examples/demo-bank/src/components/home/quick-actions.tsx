"use client"
import { Remixable } from "@vendoai/ui/chrome"
import { useToast } from "@/components/ui/toast"
import { QuickActionsView } from "./quick-actions-view"

/**
 * Container for the quick-actions strip. The toast plumbing lives HERE, on
 * the host side of the fork boundary, and reaches the presentational view
 * through a function prop — plumbing a fork cannot carry, so a remix renders
 * the ported view sandboxed and rewires behavior through the host's API.
 */
export function QuickActions() {
  const toast = useToast()
  return (
    <Remixable>
      <QuickActionsView
        onAction={() =>
          toast({ title: "Demo only", description: "This action is presentational in the demo." })
        }
      />
    </Remixable>
  )
}
