"use client";

/**
 * The shared Vendo provider root for the Maple host.
 *
 * Wires the client to the server-only agent over an HTTP transport (the agent
 * itself can't run in the browser — Composio uses Node internals), and supplies
 * the prewired component registry + impls to the shell. All embed surfaces mount
 * inside one VendoRoot so they share a single agent session/thread.
 *
 * renderNode uses the shell's in-process impls renderer: our prewired components
 * are trusted, so they render directly. The sandboxed VendoStage handles
 * untrusted *generated* UI (the F3b path, now wired in via ENG-180).
 */
import { useMemo, type ReactNode } from "react";
import { DefaultChatTransport } from "ai";
import type { VendoUIMessage } from "@vendoai/core";
import { VendoProvider } from "@vendoai/react";
import { VendoShellProvider } from "@vendoai/shell";
import { prewiredComponents, VendoThemeProvider, brandToCssVars } from "@vendoai/components";
import { mapleBrand } from "@/vendo/brand";
import { mapleHostComponents } from "@/vendo/host-components/descriptors";
import { mapleHostToolDefs } from "@/vendo/host-tools";
import { renderNode } from "./render-node";
import { createComposioIntegrations } from "./integrations";

export function VendoRoot({
  children,
  threadId = "maple-demo",
}: {
  children: ReactNode;
  /** Surfaces sharing a threadId share one conversation. The dashboard slot
   *  passes its own id so it gets an isolated thread. */
  threadId?: string;
}) {
  const transport = useMemo(
    () => new DefaultChatTransport<VendoUIMessage>({ api: "/api/vendo/chat" }),
    [],
  );

  // Restore the durable thread on mount (createVendoHandler persists it under
  // this Chat's own id): a reload — including one right after a stream died
  // mid-turn — brings back every settled message instead of an empty thread.
  const loadHistory = useMemo(
    () => async (): Promise<VendoUIMessage[]> => {
      const res = await fetch(`/api/vendo/threads/${encodeURIComponent(threadId)}`, {
        cache: "no-store",
      });
      if (!res.ok) return [];
      const body = (await res.json()) as unknown;
      return Array.isArray(body) ? (body as VendoUIMessage[]) : [];
    },
    [threadId],
  );

  // Live Composio connection status (gmail/slack) for the integrations rail.
  const integrations = useMemo(() => createComposioIntegrations(), []);

  return (
    <VendoProvider
      transport={transport}
      // Registry = the pre-wired catalog + Maple's registered host components
      // (ENG-184 registration path); genui host-node props validate against it.
      components={[...prewiredComponents, ...mapleHostComponents]}
      threadId={threadId}
      // Maple's own API tools execute HERE, in the user's browser on their
      // existing session (ENG-202, topology B) — the same definitions the
      // server registered, so gated calls run only after the approval card.
      hostTools={{ definitions: mapleHostToolDefs }}
      loadHistory={loadHistory}
    >
      {/* Maple's single brand feeds the host shell. brandToCssVars supplies the
          --vendo-* colors, applied INLINE on every .vendo-root by the shell
          (they must win over the vars styles.css declares on that same element).
          theme={{scheme:"light"}} pins colorScheme:light so the chrome can't flip
          under OS dark mode while OpenUI is forced light. VendoThemeProvider
          themes any in-process OpenUI. Same mapleBrand feeds the sandbox. */}
      <VendoThemeProvider brand={mapleBrand}>
        <VendoShellProvider
          renderNode={renderNode}
          integrations={integrations}
          theme={{ scheme: "light" }}
          cssVars={{
            ...brandToCssVars(mapleBrand),
            // Host-scope font DELIVERY override: the brand token is a concrete
            // "Inter, …" stack (it must resolve inside the sandbox, where host
            // vars don't exist), but next/font registers Inter under a mangled
            // family name exposed only as --font-inter — defined here on the
            // host page — so shell chrome keeps rendering real Inter. The
            // sandbox path (SandboxStage) uses the unmodified token.
            "--vendo-font": "var(--font-inter), Inter, ui-sans-serif, system-ui, sans-serif",
          }}
          productName="Maple"
        >
          {children}
        </VendoShellProvider>
      </VendoThemeProvider>
    </VendoProvider>
  );
}
