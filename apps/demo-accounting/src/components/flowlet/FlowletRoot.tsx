"use client";

/**
 * The shared Flowlet provider root for the Cadence host.
 *
 * Wires the client to the server-only agent over an HTTP transport (the agent
 * itself can't run in the browser — Composio uses Node internals), and supplies
 * the component registry (prewired catalog + Cadence's registered host
 * components) to the shell. All embed surfaces mount inside one FlowletRoot so
 * they share a single agent session/thread; the dashboard slot passes its own
 * threadId for an isolated thread.
 */
import { useMemo, type ReactNode } from "react";
import { DefaultChatTransport } from "ai";
import type { FlowletUIMessage } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider, createLocalIntegrations, createWebStorage } from "@flowlet/shell";
import { prewiredComponents, FlowletThemeProvider, brandToCssVars } from "@flowlet/components";
import { cadenceBrand } from "@/flowlet/brand";
import { cadenceHostComponents } from "@/flowlet/host-components/descriptors";
import { cadenceHostToolDefs } from "@/flowlet/host-tools";
import { renderNode } from "./render-node";
import { runQuery } from "./run-query";
import { listParkedActions, resolveParkedAction } from "./parked-actions";
import { createSendConsent } from "./consent";
import { listGrants, revokeGrant, queryAudit, listCriticalTools, resolveFadeProposal } from "./trust";

// The real embedded-mode store (ENG-183): saved flowlets survive reloads. One
// module-scope instance so every surface shares it; it only touches
// localStorage inside its methods, so importing it stays SSR-safe.
const store = createWebStorage({ namespace: "cadence-demo" });

// The firm's standing integrations, shown CONNECTED in the shell's in-bar
// connect tray (ENG-205) because they truly are: the agent ingests both
// Composio toolkits unconditionally (see agent.ts DEMO_TOOLKITS) — there is no
// on-screen connect flow in this app.
const integrations = createLocalIntegrations([
  { id: "gmail", name: "Gmail", connected: true },
  { id: "googlecalendar", name: "Google Calendar", connected: true },
]);

export function FlowletRoot({
  children,
  threadId = "cadence-demo",
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
  // Consent-channel POST (ENG-193 §4.5), keyed to THIS surface's thread id —
  // the same client id the transport sends, so the server resolves the same
  // persisted thread record when it validates the decision.
  const sendConsent = useMemo(() => createSendConsent(threadId), [threadId]);

  return (
    <FlowletProvider
      transport={transport}
      // Registry = the pre-wired catalog + Cadence's registered host components
      // (ENG-184 registration path); genui host-node props validate against it.
      components={[...prewiredComponents, ...cadenceHostComponents]}
      threadId={threadId}
      // Cadence's own API tools execute HERE, in the user's browser on their
      // existing session (ENG-202, topology B) — the same definitions the
      // server registered, so gated calls run only after the approval card.
      hostTools={{ definitions: cadenceHostToolDefs }}
    >
      {/* Cadence's single brand feeds the host shell. brandToCssVars supplies
          the --flowlet-* colors, applied INLINE on every .flowlet-root by the
          shell. theme={{scheme:"light"}} pins colorScheme:light so the chrome
          can't flip under OS dark mode. Same cadenceBrand feeds the sandbox. */}
      <FlowletThemeProvider brand={cadenceBrand}>
        <FlowletShellProvider
          renderNode={renderNode}
          integrations={integrations}
          store={store}
          runQuery={runQuery}
          sendConsent={sendConsent}
          parkedActions={{ list: listParkedActions, resolve: resolveParkedAction }}
          trust={{ listGrants, revokeGrant, queryAudit, listCriticalTools, resolveFadeProposal }}
          // Same registry as FlowletProvider — reopened saved views diff their
          // host-component stamp against it and surface drift (ENG-186).
          components={[...prewiredComponents, ...cadenceHostComponents]}
          theme={{ scheme: "light" }}
          cssVars={{
            ...brandToCssVars(cadenceBrand),
            // Host-scope font DELIVERY override: the brand token is a concrete
            // "Hanken Grotesk, …" stack (it must resolve inside the sandbox,
            // where host vars don't exist), but next/font registers the family
            // under a mangled name exposed only as --font-hanken — defined on
            // the host page — so shell chrome keeps rendering the real font.
            // The sandbox path (SandboxStage) uses the unmodified token.
            "--flowlet-font": "var(--font-hanken), 'Hanken Grotesk', ui-sans-serif, system-ui, sans-serif",
          }}
          productName="Vendo"
        >
          {children}
        </FlowletShellProvider>
      </FlowletThemeProvider>
    </FlowletProvider>
  );
}
