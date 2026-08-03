"use client";

import { createVendoClient, hostComponentMap, VendoProvider } from "@vendoai/ui";
import { useMemo, type ComponentProps } from "react";
import type { PackProvider } from "@vendoai/core";
import { packComponents } from "./packs/components.js";
import type { PackContext } from "./packs/merge.js";

// Named re-exports, not `export *`: this file is a "use client" boundary, and
// Next's flight loader builds the client-reference manifest by statically
// enumerating a client module's named exports — it cannot do that through
// `export *`. This list must stay in exact parity with @vendoai/ui's public
// surface (packages/ui/src/index.ts); react-export-parity.test.ts fails loudly
// if a future ui export is missing here.
export {
  // client.ts
  APPROVALS_DECIDED_EVENT,
  createVendoClient,
  type ApprovalsDecidedDetail,
  type VendoClient,
  type VendoClientConfig,
  // context.ts
  VendoProvider,
  hostComponentMap,
  useVendoContext,
  useVendoDiscoverability,
  useVendoGreeting,
  useVendoTheme,
  useVendoTools,
  type ConnectorOption,
  type HostComponentsInput,
  // chrome/discoverability.ts
  defaultVendoGreeting,
  type VendoDiscoverability,
  type VendoGreeting,
  // chrome/humanize.ts
  type ToolMeta,
  type ToolMetaMap,
  // chrome/embeds.tsx — the BYO-agent embeds (existing-agents)
  VendoAppEmbed,
  VendoApprovalEmbed,
  VendoToolResult,
  // hooks/*
  useActivity,
  useApp,
  useAppGrants,
  useApps,
  useApprovals,
  useAutomations,
  useConnections,
  useConnectorCatalog,
  useGrants,
  useApprovalSheetPresentation,
  useMobileTakeover,
  type MobileTakeover,
  type PollOptions,
  useSlotApp,
  useThreads,
  useVendoOverlay,
  type VendoOverlayController,
  useVendoStatus,
  useVendoThread,
  type VendoThreadApproval,
  ScriptedTransport,
  type DirectorCue,
  type DirectorScript,
  // pin-events.ts — the bus a slot re-reads on, for a host that pins from its
  // own control instead of a Vendo surface.
  announcePin,
  onPinAnnounced,
  // theme.ts
  defaultVendoTheme,
  resolveTheme,
  themeCssVariables,
  // voice/use-voice.ts
  useVoice,
  type UseVoiceResult,
  // wire-types.ts
  type OpenSurface,
  type InClientVenue,
  type PinDrift,
  type ShipDiff,
  type EditResult,
  type PinRebaseResult,
  type VersionEntry,
  type ConnectionAccount,
  type InitiatedConnection,
  type RunStatus,
  type RunRecord,
  type RunPlan,
  type AutomationEntry,
  type EnableResult,
  type Thread,
  type ThreadSummary,
  type GuardPosture,
  type VendoStatus,
} from "@vendoai/ui";
// The visible agent surface (launcher pill + panel) — re-exported from the
// chrome subpath so the init-scaffolded layout wrapper can import everything
// from "@vendoai/vendo/react": hosts only get @vendoai/vendo as a direct
// dependency, and under pnpm strict linking the transitive "@vendoai/ui/chrome"
// does not resolve for them (same TS2307 story as the registry's
// ComponentRegistry import).
export { VendoOverlay, type VendoOverlayProps } from "@vendoai/ui/chrome";

type ProviderProps = ComponentProps<typeof VendoProvider>;

/**
 * 09-vendo §1 — the UI provider prewired to the default wire base.
 *
 * `packs` is the CLIENT half of `createVendo({ packs })`: a pack module is
 * imported twice, and this is where its components get mounted (design §5).
 *
 * Pass the packs that SHIP COMPONENTS — not necessarily the whole server list.
 * `apps()` in particular belongs only on the server: it value-imports
 * `@vendoai/apps`, so naming it here would pull the apps block into the client
 * bundle. It contributes no components, so there is nothing to lose by leaving it
 * out. The host's own `components` still win a repeated name.
 */
export function VendoRoot(props: Omit<ProviderProps, "client"> & {
  client?: ProviderProps["client"];
  baseUrl?: string;
  packs?: readonly PackProvider<PackContext>[];
}): ReturnType<typeof VendoProvider> {
  const { client: configuredClient, baseUrl = "/api/vendo", packs, components, ...providerProps } = props;
  const defaultClient = useMemo(() => createVendoClient({ baseUrl }), [baseUrl]);
  // Both sides normalize to the plain name→component map (the components input
  // is one form or the other, never a mix), and the host's own registrations are
  // spread last so they win a repeated name — the same precedence the server
  // gives them over a pack's components.
  const merged = useMemo(
    () => (packs === undefined
      ? components
      : { ...hostComponentMap(packComponents(packs)), ...hostComponentMap(components) }),
    [packs, components],
  );
  return (
    <VendoProvider
      {...providerProps}
      {...(merged === undefined ? {} : { components: merged })}
      client={configuredClient ?? defaultClient}
    />
  );
}
