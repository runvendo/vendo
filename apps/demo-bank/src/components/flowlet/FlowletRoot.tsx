"use client";

/**
 * The shared Flowlet provider root for the Maple host.
 *
 * Wires the client to the server-only agent over an HTTP transport (the agent
 * itself can't run in the browser — Composio uses Node internals), and supplies
 * the prewired component registry + impls to the shell. All embed surfaces mount
 * inside one FlowletRoot so they share a single agent session/thread.
 *
 * renderNode uses the shell's in-process impls renderer: our prewired components
 * are trusted, so they render directly. The sandboxed FlowletStage handles
 * untrusted *generated* UI (the F3b path, now wired in via ENG-180).
 */
import { useMemo, type ReactNode } from "react";
import { DefaultChatTransport } from "ai";
import type { FlowletUIMessage } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider, type FlowletTheme } from "@flowlet/shell";
import { prewiredComponents } from "@flowlet/components";
import { renderNode } from "./render-node";
import { createComposioIntegrations } from "./integrations";

/**
 * Flowlet inherits the host app's brand — it has no color of its own. These are
 * Maple's brand tokens; drop Flowlet into a different app and you pass that app's
 * tokens here instead. Maple's accent is graphite (codex-clean), so Flowlet reads
 * as native, not bolted-on.
 */
const mapleTheme: FlowletTheme = {
  accent: "#1B1C22",
  accentFg: "#FFFFFF",
  fg: "#14151A",
  fgMuted: "#8A8B92",
  bg: "#F4F3F0",
  surface: "#FFFFFF",
  border: "#ECEBE8",
  radius: "16px",
  shadow: "0 1px 2px rgba(20,21,26,.04), 0 12px 40px rgba(20,21,26,.10)",
  font: "var(--font-inter), ui-sans-serif, system-ui, sans-serif",
};

export function FlowletRoot({ children }: { children: ReactNode }) {
  const transport = useMemo(
    () => new DefaultChatTransport<FlowletUIMessage>({ api: "/api/flowlet/chat" }),
    [],
  );

  // Live Composio connection status (gmail/slack) for the integrations rail.
  const integrations = useMemo(() => createComposioIntegrations(), []);

  return (
    <FlowletProvider transport={transport} components={prewiredComponents} threadId="maple-demo">

      <FlowletShellProvider renderNode={renderNode} integrations={integrations} theme={mapleTheme}>
        {children}
      </FlowletShellProvider>
    </FlowletProvider>
  );
}
