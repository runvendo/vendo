"use client";

/**
 * In-thread Connect card. The agent renders this (via render_ui name "Connect")
 * when a request needs a toolkit the user hasn't connected yet. Clicking Connect
 * POSTs to the demo connection store, which both flips the rail state and makes a
 * fresh chat agent ingest the toolkit on the next turn.
 *
 * Reuses the shell's ConnectCard (brand logo + button) for the idle look, then
 * shows connecting -> connected status. On success it dispatches a window event
 * so the Integrations rail can refresh.
 */
import { useState } from "react";
import { ConnectCard, type Integration } from "@flowlet/shell";

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
      const res = await fetch("/api/flowlet/integrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: toolkit, action: "connect" }),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`connect failed: ${res.status}`);
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
          Connecting {name}…
        </div>
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
