import type { ComponentType } from "react";
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
};
