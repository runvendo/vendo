"use client";

/**
 * In-thread Connect card. The agent renders this (via render_ui name "Connect")
 * when a request needs a toolkit the user hasn't connected yet. Clicking Connect
 * runs the REAL Composio OAuth flow: authorize → open the provider consent in a
 * popup → poll until the connection is ACTIVE, at which point the demo store is
 * marked connected so a fresh chat agent ingests the toolkit on the next turn.
 *
 * Reuses the shell's ConnectCard (brand logo + button) for the idle look, then
 * shows connecting -> connected status. On success it dispatches a window event
 * so the Integrations rail can refresh.
 */
import { useState } from "react";
import { ConnectCard, type Integration } from "@flowlet/shell";
import { runConnectFlow } from "./connect-flow";

const NAMES: Record<string, string> = {
  gmail: "Gmail",
  slack: "Slack",
  notion: "Notion",
  github: "GitHub",
  googlecalendar: "Google Calendar",
  linear: "Linear",
  googledrive: "Google Drive",
  discord: "Discord",
  googlesheets: "Google Sheets",
  stripe: "Stripe",
  jira: "Jira",
  asana: "Asana",
  hubspot: "HubSpot",
  airtable: "Airtable",
};

type Status = "idle" | "connecting" | "connected" | "error";

export function DemoConnectCard({ toolkit, reason }: { toolkit: string; reason?: string }) {
  const [status, setStatus] = useState<Status>("idle");
  const name = NAMES[toolkit] ?? toolkit;
  const integration: Integration = { id: toolkit, name, connected: status === "connected" };

  async function connect() {
    setStatus("connecting");
    try {
      const result = await runConnectFlow(toolkit);
      if (result !== "active") {
        setStatus("error");
        return;
      }
      setStatus("connected");
      // Let the integrations rail (and anything else) reconcile.
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("flowlet:integrations-changed", { detail: { id: toolkit } }),
        );
      }
    } catch {
      setStatus("error");
    }
  }

  if (status === "connected") {
    return (
      <div className="fl-connect" role="status" aria-label={`${name} connected`}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
          {name} connected
        </div>
        <div style={{ fontSize: 12, marginTop: 6 }}>
          Ask again and I can use {name}.
        </div>
      </div>
    );
  }

  if (status === "connecting") {
    return (
      <div className="fl-connect" role="status" aria-label={`Connecting ${name}`}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
          <span
            aria-hidden
            style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              border: "2px solid currentColor",
              borderTopColor: "transparent",
              display: "inline-block",
              animation: "fl-spin 0.7s linear infinite",
            }}
          />
          Connecting {name}…
        </div>
        <div style={{ fontSize: 12, marginTop: 6, opacity: 0.8 }}>
          Finish in the popup window, then we will pick it up automatically.
        </div>
        <style>{"@keyframes fl-spin { to { transform: rotate(360deg) } }"}</style>
      </div>
    );
  }

  return (
    <div>
      <ConnectCard integration={integration} reason={reason} onConnect={connect} />
      {status === "error" && (
        <div style={{ fontSize: 12, marginTop: 6, color: "#b00020" }}>
          Could not connect {name}. Try again.
        </div>
      )}
    </div>
  );
}
