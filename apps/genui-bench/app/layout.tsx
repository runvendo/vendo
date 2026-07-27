import type { ReactNode } from "react";

export const metadata = { title: "genui-bench" };

/**
 * Deliberately styleless. The cockpit imports its own chrome sheet in
 * app/page.tsx and each `/embed/<host>` document imports only that demo host's
 * real stylesheet, so the two never share a rule: no host CSS can reach the
 * cockpit's hand-rolled dark UI, and no cockpit CSS can tint a generated app.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
