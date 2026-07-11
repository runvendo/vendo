import type { ReactNode } from "react";

export interface VendoRemixProps {
  children?: ReactNode;
  [key: string]: unknown;
}

/** Kept as a passthrough because existing hosts have this wrapper in source. */
export function VendoRemix({ children }: VendoRemixProps) {
  return children;
}
