import React from "react";
export function Card({ title, body }: { title: string; body: string }) {
  return (
    <div data-testid="host-card" style={{ background: "var(--brand-surface)", color: "var(--brand-text)", padding: 16, borderRadius: 8 }}>
      <h3 style={{ color: "var(--brand-primary)" }}>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
