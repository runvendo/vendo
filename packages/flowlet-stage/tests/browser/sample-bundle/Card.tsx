import React from "react";

interface CardProps {
  title: string;
  body: string;
  accountName?: string;
  action?: { action: string; label: string; payload?: unknown };
  __nodeId?: string;
}

export function Card({ title, body, accountName, action, __nodeId }: CardProps) {
  return (
    <div
      data-testid="host-card"
      style={{
        background: "var(--flowlet-surface)",
        color: "var(--flowlet-fg)",
        padding: 16,
        borderRadius: 8,
      }}
    >
      <h3 style={{ color: "var(--flowlet-accent)" }}>{title}</h3>
      <p>{body}</p>
      {accountName ? <span data-testid="card-account">{accountName}</span> : null}
      {action ? (
        <button
          data-testid="card-btn"
          onClick={() => (globalThis as any).__flowletDispatch(action, __nodeId)}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
