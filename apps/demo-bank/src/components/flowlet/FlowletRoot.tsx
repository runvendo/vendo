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
import { FlowletShellProvider, createLocalIntegrations } from "@flowlet/shell";
import { prewiredComponents } from "@flowlet/components";
import { renderNode } from "./render-node";

export function FlowletRoot({ children }: { children: ReactNode }) {
  const transport = useMemo(
    () => new DefaultChatTransport<FlowletUIMessage>({ api: "/api/flowlet/chat" }),
    [],
  );

  // Phase 0 placeholder integration status; Phase 1 replaces with live Composio.
  const integrations = useMemo(
    () =>
      createLocalIntegrations([
        { id: "gmail", name: "Gmail", connected: true },
        { id: "slack", name: "Slack", connected: true },
      ]),
    [],
  );

  return (
    <FlowletProvider transport={transport} components={prewiredComponents}>
      <FlowletShellProvider renderNode={renderNode} integrations={integrations}>
        {children}
      </FlowletShellProvider>
    </FlowletProvider>
  );
}
