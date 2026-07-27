import type { ReactNode } from "react";

export const metadata = { title: "genui-bench" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
