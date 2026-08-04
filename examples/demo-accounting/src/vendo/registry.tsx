import type { ComponentRegistry } from "@vendoai/core";
import { z } from "zod";
import { MissingDocsHero } from "../components/dashboard/missing-docs-hero";
import { Badge, type BadgeVariant } from "../components/ui/badge";
import { ProgressBar } from "../components/ui/progress";

function CadenceStatusBadge({
  text,
  variant = "neutral",
  dot = false,
}: {
  text: string;
  variant?: BadgeVariant;
  dot?: boolean;
}) {
  return <Badge variant={variant} dot={dot}>{text}</Badge>;
}

function CadenceDocProgress({ value, max }: { value: number; max: number }) {
  return <ProgressBar value={value} max={max} />;
}

/**
 * The ONE Cadence component registry (01 §14, 08 §2 — server-wiring DX):
 * defined once, imported by both sides. `createVendo` takes it as `catalog`
 * and reads only the data fields (description/props/examples); `<VendoRoot>`
 * takes it as `components` and reads only the component references.
 */
export const cadenceRegistry = {
  CadenceStatusBadge: {
    component: CadenceStatusBadge,
    description: "Use for a compact Cadence document, client, or workflow status label when the state should be immediately scannable.",
    props: z.object({
      text: z.string(),
      variant: z.enum(["missing", "overdue", "review", "verified", "neutral"]).optional(),
      dot: z.boolean().optional(),
    }),
    examples: ['{"text":"Needs review","variant":"review","dot":true}'],
  },
  // NOTE: deliberately declares NO `examples`, unlike every other entry here.
  // It is the committed fixture for the preview seed's SECOND rung: sync
  // generates props from the `props:` schema below, so `.vendo/components/
  // CadenceDocProgress.json` carries `sampleOrigin: "generated"` and the
  // console renders a generated seed. Without one such component, the newest
  // and largest part of the seeding logic is unreachable by rendering the demos.
  // `description` and `props` still give the model everything it needs to pick
  // and fill this component; examples are guidance, not a requirement.
  CadenceDocProgress: {
    component: CadenceDocProgress,
    description: "Use for Cadence document-collection or checklist completion when the user needs progress toward a known total.",
    props: z.object({
      value: z.number(),
      max: z.number(),
    }),
  },
  CadenceMissingDocsHero: {
    component: MissingDocsHero,
    description: "The Cadence dashboard hero card: clients with outstanding documents, an action badge, and the active-client total. Use it for who-still-owes-documents or chase-list summary requests.",
    props: z.object({
      missingCount: z.number().describe("Clients with at least one outstanding document"),
      clientCount: z.number().describe("All active clients"),
      badgeLabel: z.string().optional(),
    }),
    examples: ['{"missingCount":8,"clientCount":12}'],
  },
} satisfies ComponentRegistry;
