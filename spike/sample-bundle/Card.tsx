import React from "react";
export function Card({ title, body, accountName, action, __nodeId }: { title: string; body: string; accountName?: string; action?: { action: string; label: string; payload?: unknown }; __nodeId?: string }) {
  return (
    <div data-testid="host-card" style={{ background: "var(--brand-surface)", color: "var(--brand-text)", padding: 16, borderRadius: 8 }}>
      <h3 style={{ color: "var(--brand-primary)" }}>{title}</h3>
      <p>{body}</p>
      {accountName ? <span data-testid="card-account">{accountName}</span> : null}
      {action ? (
        <button data-testid="card-btn" onClick={() => (globalThis as any).__flowletDispatch(action, __nodeId)}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
