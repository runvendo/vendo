"use client";

/**
 * `<FlowletRoot>` — the one client component `flowlet init` wires into the
 * app's root layout. Composes the shipped Flowlet surfaces against the routes
 * `createFlowletHandler()` serves:
 *
 *   FlowletProvider (HTTP transport → /chat, browser host-tool executor)
 *   └ FlowletThemeProvider (brand from .flowlet/theme.json)
 *     └ FlowletShellProvider (sandboxed renderNode, saved-view store,
 *        reads-only query replay, capability-gated integrations)
 *       └ children + FlowletOverlay (Cmd/Ctrl+K) + a floating launcher pill
 *
 * Capability-additive: the integrations tray only appears when the server
 * reports the Composio capability; voice stays behind its flag (ENG-185).
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { DefaultChatTransport } from "ai";
import type { FlowletUIMessage, ManifestTool, UINode } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import {
  FlowletOverlay,
  FlowletShellProvider,
  createLocalIntegrations,
  createWebRemixes,
  createWebStorage,
  type FlowletIntegrations,
} from "@flowlet/shell";
import { FlowletThemeProvider } from "@flowlet/components";
import { brandTokensSchema, defaultBrand, type BrandTokens } from "@flowlet/components/theme";
import { brandToCssVars } from "@flowlet/components/descriptors";
import { manifestToolsToHostTools } from "../manifest-tools";
import type { FlowletCapabilities } from "../capabilities";
import { SandboxStage } from "./sandbox-stage";
import { FlowletConnectNode } from "./connect-node";
import { createServerIntegrations } from "./integrations";
import { createServerNotifications } from "./notifications";
import { createRunQuery } from "./run-query";

export interface FlowletRootProps {
  /** `.flowlet/theme.json`, imported as JSON. Invalid/absent → default brand. */
  theme?: unknown;
  /** `.flowlet/tools.json`, imported as JSON ({ tools: [...] } or the array). */
  tools?: unknown;
  /** What the assistant calls itself/the product. */
  productName?: string;
  /** Mount path of the catch-all route. Default "/api/flowlet". */
  basePath?: string;
  /** Surfaces sharing a threadId share one conversation. */
  threadId?: string;
  greeting?: string;
  suggestions?: string[];
  /** "pill" (default) renders a floating launcher; "none" = Cmd/Ctrl+K only. */
  launcher?: "pill" | "none";
  children: ReactNode;
}

function parseBrand(theme: unknown): BrandTokens {
  if (theme === undefined || theme === null) return defaultBrand;
  const parsed = brandTokensSchema.safeParse(theme);
  if (!parsed.success) {
    console.warn("[flowlet] theme.json does not match the brand-token schema; using defaults");
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
  border: "1px solid var(--flowlet-border, rgba(0,0,0,.12))",
  background: "var(--flowlet-accent, #0A7CFF)",
  color: "var(--flowlet-accent-fg, #fff)",
  font: "600 13px/1 var(--flowlet-font, system-ui, sans-serif)",
  boxShadow: "0 10px 30px rgba(0,0,0,.18)",
  cursor: "pointer",
};

export function FlowletRoot({
  theme,
  tools,
  productName = "Assistant",
  basePath = "/api/flowlet",
  threadId = "flowlet",
  greeting,
  suggestions,
  launcher = "pill",
  children,
}: FlowletRootProps) {
  const brand = useMemo(() => parseBrand(theme), [theme]);
  const manifestTools = useMemo(() => parseManifestTools(tools), [tools]);
  const hostToolDefs = useMemo(() => manifestToolsToHostTools(manifestTools), [manifestTools]);
  const [open, setOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<FlowletCapabilities | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${basePath}/capabilities`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<FlowletCapabilities>) : null))
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
    () => new DefaultChatTransport<FlowletUIMessage>({ api: `${basePath}/chat` }),
    [basePath],
  );

  // Saved flowlets survive reloads; only touches localStorage inside methods,
  // so importing stays SSR-safe.
  const store = useMemo(() => createWebStorage({ namespace: `flowlet:${threadId}` }), [threadId]);

  // Remix pins (FlowletRemix) follow the same web-storage pattern; the
  // notifications client polls the handler's deliveries feed (FlowletToasts).
  const remixes = useMemo(() => createWebRemixes({ namespace: `flowlet:${threadId}` }), [threadId]);
  const notifications = useMemo(() => createServerNotifications(basePath), [basePath]);

  const integrations = useMemo<FlowletIntegrations>(
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
          <FlowletConnectNode
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
    <FlowletProvider
      transport={transport}
      components={[]}
      threadId={threadId}
      hostTools={{ definitions: hostToolDefs }}
    >
      <FlowletThemeProvider brand={brand}>
        <FlowletShellProvider
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
            <FlowletOverlay
              launcherLabel={`Ask ${productName}`}
              open={open}
              onOpenChange={setOpen}
              {...(greeting !== undefined ? { greeting } : {})}
              {...(suggestions !== undefined ? { suggestions } : {})}
            />
          )}
          {chatEnabled && launcher === "pill" && !open && (
            /* Provisional default launcher (flagged for design review): built
               from shell tokens only, replaceable via launcher="none". */
            <button type="button" style={LAUNCHER_STYLE} onClick={() => setOpen(true)}>
              Ask {productName}
            </button>
          )}
        </FlowletShellProvider>
      </FlowletThemeProvider>
    </FlowletProvider>
  );
}
