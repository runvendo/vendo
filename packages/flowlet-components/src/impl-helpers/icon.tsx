import type { ReactNode } from "react";
import * as Lucide from "lucide-react";

type LucideComponent = React.ComponentType<{ size?: string | number }>;

/** Resolve a lucide icon by PascalCase name (e.g. "FlaskConical"). Unknown -> null. */
export function resolveIcon(name: unknown, size: string | number = "1em"): ReactNode {
  if (typeof name !== "string") return null;
  const candidate = (Lucide as Record<string, unknown>)[name];
  if (typeof candidate !== "function") return null;
  const Icon = candidate as LucideComponent;
  return <Icon size={size} />;
}
