import React from "react";
export function Row({ children }: { children?: React.ReactNode }) {
  return <div data-testid="row">{children}</div>;
}
