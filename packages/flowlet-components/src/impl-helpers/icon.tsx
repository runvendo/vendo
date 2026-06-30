import type { ReactNode } from "react";
import * as Lucide from "lucide-react";

type LucideComponent = React.ComponentType<{ size?: string | number }>;

const FORWARD_REF_TYPE = Symbol.for("react.forward_ref");

/**
 * Convert kebab-case or snake_case or plain lowercase to PascalCase.
 * "wallet" → "Wallet", "wallet-cards" → "WalletCards", "wallet_cards" → "WalletCards".
 */
function toPascalCase(name: string): string {
  return name
    .split(/[-_\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Resolve a lucide icon by name. Accepts PascalCase ("Wallet"),
 * kebab-case ("wallet-cards"), snake_case ("wallet_cards"), or lowercase ("wallet").
 * Returns null for unknown names or non-icon exports like `createLucideIcon`.
 */
export function resolveIcon(name: unknown, size: string | number = "1em"): ReactNode {
  if (typeof name !== "string") return null;
  const resolved = toPascalCase(name);
  const candidate = (Lucide as Record<string, unknown>)[resolved];
  // Lucide icon components are React.forwardRef objects; reject plain functions
  // like `createLucideIcon` which are not forwardRef components.
  if (
    candidate === null ||
    candidate === undefined ||
    typeof candidate !== "object" ||
    (candidate as { $$typeof?: unknown }).$$typeof !== FORWARD_REF_TYPE
  ) {
    return null;
  }
  const Icon = candidate as unknown as LucideComponent;
  return <Icon size={size} />;
}
