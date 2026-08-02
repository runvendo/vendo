import type { ReactNode } from "react";

/** Local stand-in for @vendoai/ui's Remixable: sync keys on the JSX tag name,
 * and a real dependency would drag the whole ui package into this fixture. */
export function Remixable({ children }: { review?: boolean; children: ReactNode }) {
  return <>{children}</>;
}
