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
import { FlowletShellProvider, createWebStorage } from "@flowlet/shell";
import { prewiredComponents, FlowletThemeProvider, brandToCssVars } from "@flowlet/components";
import { mapleBrand } from "@/flowlet/brand";
import { mapleHostToolDefs } from "@/flowlet/host-tools";
import { renderNode } from "./render-node";
import { createComposioIntegrations } from "./integrations";
import { runQuery } from "./run-query";

// The real embedded-mode store (ENG-183): saved flowlets survive reloads. One
// module-scope instance so every surface shares it; it only touches
// localStorage inside its methods, so importing it stays SSR-safe.
const store = createWebStorage({ namespace: "maple-demo" });

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
    <FlowletProvider
      transport={transport}
      components={prewiredComponents}
      threadId={threadId}
      // Maple's own API tools execute HERE, in the user's browser on their
      // existing session (ENG-202, topology B) — the same definitions the
      // server registered, so gated calls run only after the approval card.
      hostTools={{ definitions: mapleHostToolDefs }}
    >
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
          store={store}
          runQuery={runQuery}
          theme={{ scheme: "light" }}
          cssVars={{
            ...brandToCssVars(mapleBrand),
            // Host-scope font DELIVERY override: the brand token is a concrete
            // "Inter, …" stack (it must resolve inside the sandbox, where host
            // vars don't exist), but next/font registers Inter under a mangled
            // family name exposed only as --font-inter — defined here on the
            // host page — so shell chrome keeps rendering real Inter. The
            // sandbox path (SandboxStage) uses the unmodified token.
            "--flowlet-font": "var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif",
          }}
        >
          {children}
        </FlowletShellProvider>
      </FlowletThemeProvider>
    </FlowletProvider>
  );
}
