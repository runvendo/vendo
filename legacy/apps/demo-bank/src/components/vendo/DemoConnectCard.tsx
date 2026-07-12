"use client";

/**
 * In-thread Connect card. The agent renders this (via the request_connect tool)
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
import { useVendoChat } from "@vendoai/react";
import { BrandIcon, ConnectCard, type Integration } from "@vendoai/shell";
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

type Status = "idle" | "connecting" | "connected" | "needs-auth" | "error";

export function DemoConnectCard({ toolkit, reason }: { toolkit: string; reason?: string }) {
  const [status, setStatus] = useState<Status>("idle");
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const { sendMessage } = useVendoChat();
  const name = NAMES[toolkit] ?? toolkit;
  const integration: Integration = { id: toolkit, name, connected: status === "connected" };

  function onConnected() {
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("vendo:integrations-changed", { detail: { id: toolkit } }),
      );
    }
    // Auto-continue: the agent now has the tool, so pick up where we left off
    // instead of making the user re-ask.
    void sendMessage({ text: `I've connected ${name}. Go ahead and continue.` });
  }

  async function connect() {
    setStatus("connecting");
    try {
      const outcome = await runConnectFlow(toolkit);
      if (outcome.result === "active") {
        setStatus("connected");
        onConnected();
      } else if (outcome.result === "needs-auth") {
        setAuthUrl(outcome.redirectUrl);
        setStatus("needs-auth");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  if (status === "connected") {
    // Quiet status pill: the flow auto-continues, so no instructions needed.
    return (
      <div className="fl-connect-done" role="status" aria-label={`${name} connected`}>
        <BrandIcon id={toolkit} size={15} />
        {name} connected
        <span className="fl-connect-done-dot" aria-hidden />
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

  if (status === "needs-auth" && authUrl) {
    return (
      <div className="fl-connect" role="group" aria-label={`Authorize ${name}`}>
        <div style={{ fontWeight: 600 }}>Authorize {name}</div>
        <div style={{ fontSize: 12, margin: "6px 0 11px", opacity: 0.85 }}>
          Open the secure {name} window, approve access, then continue.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <a className="fl-btn fl-btn-primary" href={authUrl} target="_blank" rel="noopener noreferrer">
            Open {name}
          </a>
          <button type="button" className="fl-btn" onClick={connect}>
            I&rsquo;ve authorized
          </button>
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
