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
 * are trusted, so they render directly. The sandboxed FlowletStage is reserved
 * for untrusted *generated* UI (the F3b path, wired when ENG-180 lands).
 */
import { useMemo, type ReactNode } from "react";
import { DefaultChatTransport } from "ai";
import type { FlowletUIMessage } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider, type FlowletTheme } from "@flowlet/shell";
import { prewiredComponents } from "@flowlet/components";
import { renderNode } from "./render-node";
import { createComposioIntegrations } from "./integrations";

/** Flowlet themed to Maple's brand so the layer feels native, not bolted-on. */
const mapleTheme: FlowletTheme = {
  accent: "#1E7F53",
  accentFg: "#FFFFFF",
  fg: "#111111",
  fgMuted: "#908C85",
  bg: "#FBFBFA",
  surface: "#FFFFFF",
  border: "#ECEBE8",
  radius: "14px",
  shadow: "0 18px 50px rgba(27,30,37,.14)",
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
