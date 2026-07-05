"use client";

/**
 * `<VendoRoot>` — the one client component `vendo init` wires into the
 * app's root layout. Composes the shipped Vendo surfaces against the routes
 * `createVendoHandler()` serves:
 *
 *   VendoProvider (HTTP transport → /chat, browser host-tool executor)
 *   └ VendoThemeProvider (brand from .vendo/theme.json)
 *     └ VendoShellProvider (sandboxed renderNode, saved-view store,
 *        reads-only query replay, capability-gated integrations)
 *       └ children + VendoOverlay (Cmd/Ctrl+K) + a floating launcher pill
 *
 * Capability-additive: the integrations tray only appears when the server
 * reports the Composio capability; voice stays behind its flag (ENG-185).
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { DefaultChatTransport } from "ai";
import type { VendoUIMessage, ManifestTool, UINode } from "@vendoai/core";
import { VendoProvider } from "@vendoai/react";
import {
  VendoOverlay,
  VendoShellProvider,
  VendoToasts,
  createLocalIntegrations,
  createWebRemixes,
  createWebStorage,
  type VendoIntegrations,
  type VendoToastsProps,
} from "@vendoai/shell";
import { createServerVendoStore } from "./server-store";
import { VendoThemeProvider } from "@vendoai/components";
import { brandTokensSchema, defaultBrand, type BrandTokens } from "@vendoai/components/theme";
import { brandToCssVars } from "@vendoai/components/descriptors";
import { manifestToolsToHostTools } from "@vendoai/server/manifest-tools";
import type { VendoCapabilities } from "@vendoai/server/capabilities";
import { SandboxStage } from "./sandbox-stage";
import { VendoConnectNode } from "./connect-node";
import { createServerIntegrations } from "./integrations";
import { createServerNotifications } from "./notifications";
import { createRunQuery } from "./run-query";
import type { VoiceDriver } from "@vendoai/shell";

export interface VendoRootProps {
  /** `.vendo/theme.json`, imported as JSON. Invalid/absent → default brand. */
  theme?: unknown;
  /** `.vendo/tools.json`, imported as JSON ({ tools: [...] } or the array). */
  tools?: unknown;
  /** What the assistant calls itself/the product. */
  productName?: string;
  /** Mount path of the catch-all route. Default "/api/vendo". */
  basePath?: string;
  /** Surfaces sharing a threadId share one conversation. */
  threadId?: string;
  greeting?: string;
  suggestions?: string[];
  /** "pill" (default) renders a floating launcher; "none" = Cmd/Ctrl+K only. */
  launcher?: "pill" | "none";
  /** Automation toasts (VendoToasts) mount by default; `false` opts out. */
  toasts?: boolean;
  /** Corner for the toast stack. Default "bottom-left" (the launcher pill
   *  owns bottom-right). */
  toastPlacement?: VendoToastsProps["placement"];
  /** Realtime voice driver (ENG-185). When provided, the overlay's composer
   *  grows a mic. Build one with createRealtimeVoiceDriver from
   *  @vendoai/shell against a host session-mint endpoint. */
  voice?: VoiceDriver;
  children: ReactNode;
}

function parseBrand(theme: unknown): BrandTokens {
  if (theme === undefined || theme === null) return defaultBrand;
  const parsed = brandTokensSchema.safeParse(theme);
  if (!parsed.success) {
    console.warn("[vendo] theme.json does not match the brand-token schema; using defaults");
    return defaultBrand;
  }
  return parsed.data;
}

function parseManifestTools(tools: unknown): ManifestTool[] {
  if (Array.isArray(tools)) return tools as ManifestTool[];
  if (tools && typeof tools === "object" && Array.isArray((tools as { tools?: unknown }).tools)) {
    return (tools as { tools: ManifestTool[] }).tools;
  }
  return [];
}

const LAUNCHER_STYLE: CSSProperties = {
  position: "fixed",
  right: 22,
  bottom: 22,
  zIndex: 2147483000,
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 16px",
  borderRadius: 999,
  border: "1px solid var(--vendo-border, rgba(0,0,0,.12))",
  background: "var(--vendo-accent, #0A7CFF)",
  color: "var(--vendo-accent-fg, #fff)",
  font: "600 13px/1 var(--vendo-font, system-ui, sans-serif)",
  boxShadow: "0 10px 30px rgba(0,0,0,.18)",
  cursor: "pointer",
};

export function VendoRoot({
  theme,
  tools,
  productName = "Assistant",
  basePath = "/api/vendo",
  threadId = "vendo",
  greeting,
  suggestions,
  launcher = "pill",
  toasts = true,
  toastPlacement = "bottom-left",
  voice,
  children,
}: VendoRootProps) {
  const brand = useMemo(() => parseBrand(theme), [theme]);
  const manifestTools = useMemo(() => parseManifestTools(tools), [tools]);
  const hostToolDefs = useMemo(() => manifestToolsToHostTools(manifestTools), [manifestTools]);
  const [open, setOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<VendoCapabilities | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${basePath}/capabilities`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<VendoCapabilities>) : null))
      .then((caps) => {
        if (!cancelled && caps) setCapabilities(caps);
      })
      .catch(() => {
        /* capabilities stay null → most conservative UI */
      });
    return () => {
      cancelled = true;
    };
  }, [basePath]);

  const transport = useMemo(
    // Static `body` merges into every request the transport sends — this is
    // how the server-side thread persistence (createVendoHandler's /chat)
    // knows which thread to upsert into. Surfaces sharing a threadId share a
    // durable conversation, not just a client-side one.
    () => new DefaultChatTransport<VendoUIMessage>({ api: `${basePath}/chat`, body: { threadId } }),
    [basePath, threadId],
  );

  // Saved vendos survive reloads. Server-backed (durable across devices,
  // no localStorage quota) when the handler reports the `storage` capability;
  // localStorage otherwise — including the optimistic `capabilities === null`
  // window before the fetch above resolves, which is why `capabilities?.storage`
  // (not `capabilities`) drives this: the store switches under the surfaces
  // using it the moment capabilities land, never blocking on them. No
  // localStorage→server migration in v1 (see docs/persistence-and-deploy.md).
  // Only touches localStorage inside its own methods, so importing stays SSR-safe.
  const store = useMemo(
    () =>
      capabilities?.storage
        ? createServerVendoStore(basePath)
        : createWebStorage({ namespace: `vendo:${threadId}` }),
    [capabilities?.storage, basePath, threadId],
  );

  // Remix pins (VendoRemix) follow the same web-storage pattern; the
  // notifications client polls the handler's deliveries feed (VendoToasts).
  const remixes = useMemo(() => createWebRemixes({ namespace: `vendo:${threadId}` }), [threadId]);
  const notifications = useMemo(() => createServerNotifications(basePath), [basePath]);

  const integrations = useMemo<VendoIntegrations>(
    () =>
      capabilities?.integrations
        ? createServerIntegrations(basePath)
        : createLocalIntegrations([]),
    [capabilities?.integrations, basePath],
  );

  const runQuery = useMemo(() => createRunQuery(basePath, manifestTools), [basePath, manifestTools]);

  const renderNode = useMemo(() => {
    const render = (node: UINode): ReactNode => {
      // The one host-rendered, trusted exception: the Connect OAuth card.
      if (node.kind === "component" && node.name === "Connect") {
        const props = (node.props ?? {}) as Record<string, unknown>;
        return (
          <VendoConnectNode
            toolkit={typeof props["toolkit"] === "string" ? props["toolkit"] : ""}
            {...(typeof props["reason"] === "string" ? { reason: props["reason"] } : {})}
            basePath={basePath}
          />
        );
      }
      // Everything else the agent produces renders untrusted in the sandbox.
      if (node.kind === "generated") {
        return <SandboxStage node={node} brand={brand} components={[]} basePath={basePath} />;
      }
      // Unexpected: only "Connect" is host-rendered. Fail loud but contained.
      return <div data-testid="unexpected-node">{node.name} (not renderable)</div>;
    };
    return render;
  }, [basePath, brand]);

  // Capability-additive contract: with no ANTHROPIC_API_KEY the server reports
  // chat:false, and asking would 401 inside the stream. Hide the assistant
  // surface entirely in that case rather than degrading into a runtime error.
  // `null` (not yet fetched) renders optimistically so there is no flicker.
  const chatEnabled = capabilities === null || capabilities.chat;

  return (
    <VendoProvider
      transport={transport}
      components={[]}
      threadId={threadId}
      hostTools={{ definitions: hostToolDefs }}
    >
      <VendoThemeProvider brand={brand}>
        <VendoShellProvider
          renderNode={renderNode}
          integrations={integrations}
          store={store}
          remixes={remixes}
          notifications={notifications}
          runQuery={runQuery}
          components={[]}
          theme={{ scheme: brand.mode === "dark" ? "dark" : "light" }}
          cssVars={brandToCssVars(brand)}
          productName={productName}
        >
          {children}
          {chatEnabled && (
            <VendoOverlay
              launcherLabel={`Ask ${productName}`}
              open={open}
              onOpenChange={setOpen}
              {...(greeting !== undefined ? { greeting } : {})}
              {...(suggestions !== undefined ? { suggestions } : {})}
              {...(voice !== undefined && capabilities?.voice ? { voice } : {})}
            />
          )}
          {chatEnabled && launcher === "pill" && !open && (
            /* Provisional default launcher (flagged for design review): built
               from shell tokens only, replaceable via launcher="none". */
            <button type="button" style={LAUNCHER_STYLE} onClick={() => setOpen(true)}>
              Ask {productName}
            </button>
          )}
          {toasts && (
            <VendoToasts placement={toastPlacement} namespace={`vendo:${threadId}`} />
          )}
        </VendoShellProvider>
      </VendoThemeProvider>
    </VendoProvider>
  );
}
