/**
 * React adapters binding Cadence's REAL components to their registered
 * descriptors. Compiled into the sandbox bundle (flowlet-sandbox/entry.ts) —
 * never imported by the Next app itself.
 *
 * The real Badge/ProgressBar are Tailwind-styled; the utility rules they need
 * travel into the sandbox via installFlowletHost's `css` option (see
 * flowlet-sandbox/entry.ts), so these adapters stay thin prop mappers.
 */
import { bindHostImpl } from "@flowlet/components";
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
