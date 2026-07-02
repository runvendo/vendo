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
import { FlowletShellProvider } from "@flowlet/shell";
import { prewiredComponents, FlowletThemeProvider, brandToCssVars } from "@flowlet/components";
import { mapleBrand } from "@/flowlet/brand";
import { renderNode } from "./render-node";
import { createComposioIntegrations } from "./integrations";

export function FlowletRoot({
  children,
  threadId = "maple-demo",
}: {
  children: ReactNode;
  /** Surfaces sharing a threadId share one conversation. The dashboard slot
   *  passes its own id so it gets an isolated thread. */
  threadId?: string;
}) {
  const transport = useMemo(
    () => new DefaultChatTransport<FlowletUIMessage>({ api: "/api/flowlet/chat" }),
    [],
  );

  // Live Composio connection status (gmail/slack) for the integrations rail.
  const integrations = useMemo(() => createComposioIntegrations(), []);

  return (
    <FlowletProvider transport={transport} components={prewiredComponents} threadId={threadId}>
      {/* Maple's single brand feeds the host shell. brandToCssVars supplies the
          --flowlet-* colors, applied INLINE on every .flowlet-root by the shell
          (they must win over the vars styles.css declares on that same element).
          theme={{scheme:"light"}} pins colorScheme:light so the chrome can't flip
          under OS dark mode while OpenUI is forced light. FlowletThemeProvider
          themes any in-process OpenUI. Same mapleBrand feeds the sandbox. */}
      <FlowletThemeProvider brand={mapleBrand}>
        <FlowletShellProvider
          renderNode={renderNode}
          integrations={integrations}
          theme={{ scheme: "light" }}
          cssVars={brandToCssVars(mapleBrand)}
          productName="Maple"
        >
          {children}
        </FlowletShellProvider>
      </FlowletThemeProvider>
    </FlowletProvider>
  );
}
