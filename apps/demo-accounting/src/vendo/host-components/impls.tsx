/**
 * React adapters binding Cadence's REAL components to their registered
 * descriptors. Compiled into the sandbox bundle (vendo-sandbox/entry.ts) —
 * never imported by the Next app itself.
 *
 * The real Badge/ProgressBar are Tailwind-styled; the utility rules they need
 * travel into the sandbox via installVendoHost's `css` option (see
 * vendo-sandbox/entry.ts), so these adapters stay thin prop mappers.
 */
import { bindHostImpl } from "@vendoai/components";
import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress";
import { statusBadgeDescriptor, docProgressDescriptor } from "./descriptors";

const CadenceStatusBadge = bindHostImpl(statusBadgeDescriptor, (p) => (
  <Badge variant={p.variant ?? "neutral"} dot={p.dot ?? false}>{p.text}</Badge>
));

const CadenceDocProgress = bindHostImpl(docProgressDescriptor, (p) => (
  <ProgressBar value={p.value} max={p.max} />
));

export const cadenceHostImpls = {
  CadenceStatusBadge,
  CadenceDocProgress,
};
