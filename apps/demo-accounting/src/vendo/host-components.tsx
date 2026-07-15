import type { ComponentType } from "react";
import { MissingDocsHero } from "@/components/dashboard/missing-docs-hero";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress";

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

/** Host component registration by name (08-ui §2). */
export const cadenceHostComponents: Record<string, ComponentType> = {
  CadenceStatusBadge: CadenceStatusBadge as ComponentType,
  CadenceDocProgress: CadenceDocProgress as ComponentType,
  CadenceMissingDocsHero: MissingDocsHero as ComponentType,
};

/**
 * Remixable host slots (06-apps §8), statically captured by `vendo sync` into
 * `.vendo/remixable/<slot>.json`. `sampleProps` mirror the deterministic demo
 * seed so a fork previews with the numbers the real dashboard shows.
 */
export const cadenceRemixableComponents = [
  {
    name: "CadenceMissingDocsHero",
    component: MissingDocsHero,
    remixable: true,
    exportable: true,
    sampleProps: { missingCount: 8, clientCount: 12 },
  },
];
