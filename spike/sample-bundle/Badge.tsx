import React from "react";
export function Badge({ label }: { label?: string }) {
  return <span data-prewired data-testid="badge">{label || "badge"}</span>;
}
