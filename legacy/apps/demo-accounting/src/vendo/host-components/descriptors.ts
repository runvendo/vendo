/**
 * Cadence's registered host components — the app's OWN components, offered to
 * the agent (ENG-184/186 registration path, docs/host-components.md).
 *
 * React-free on purpose: this module feeds BOTH the server (agent prompt +
 * registry validation) and the client provider. The React adapters live in
 * ./impls.tsx and are compiled into the sandbox bundle.
 *
 * The pair was chosen from the extractor's 8 wrap candidates (see the Cadence
 * extraction-fidelity report): the two that carry Cadence's visual identity
 * into generated views — the status pill every table/checklist uses, and the
 * thin document-collection meter.
 */
import { z } from "zod";
import { hostComponent, toHostRegistry } from "@vendoai/components/descriptors";

export const statusBadgeDescriptor = hostComponent(
  "CadenceStatusBadge",
  "Cadence's own status pill — the exact component the app's client table and " +
    "document checklists use, in the product's semantic status tints. Use it whenever " +
    "you show a document or client status word. Variants: 'missing' (amber), 'overdue' " +
    "(red), 'review' (blue — uploads awaiting firm review), 'verified' (green), " +
    "'neutral' (gray, default). `dot` adds the small leading status dot.",
  z.object({
    text: z.string().min(1),
    variant: z.enum(["missing", "overdue", "review", "verified", "neutral"]).optional(),
    dot: z.boolean().optional(),
  }),
);

export const docProgressDescriptor = hostComponent(
  "CadenceDocProgress",
  "Cadence's own thin document-collection meter — the exact progress bar the client " +
    "table shows for 'N of M received'. Fills proportionally and turns verified-green " +
    "at 100%. Use it next to document counts; pair with a Text caption like '3 of 6 " +
    "received'. `value` is documents received, `max` is total requested.",
  z.object({
    value: z.number().min(0),
    max: z.number().min(0),
  }),
);

export const cadenceHostDescriptors = [statusBadgeDescriptor, docProgressDescriptor];

/** F1 registry entries (source:"host") for the provider + genui validation. */
export const cadenceHostComponents = toHostRegistry(cadenceHostDescriptors);
