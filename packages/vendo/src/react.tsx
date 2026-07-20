"use client";

import { createVendoClient, VendoProvider } from "@vendoai/ui";
import { useMemo, type ComponentProps } from "react";

// Named re-exports, not `export *`: this file is a "use client" boundary, and
// Next's flight loader builds the client-reference manifest by statically
// enumerating a client module's named exports — it cannot do that through
// `export *`. This list must stay in exact parity with @vendoai/ui's public
// surface (packages/ui/src/index.ts); react-export-parity.test.ts fails loudly
// if a future ui export is missing here.
export {
  // client.ts
  createVendoClient,
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
  // hooks/*
  useActivity,
  useApp,
  useApps,
  useApprovals,
  useAutomations,
  useConnections,
  useConnectorCatalog,
  useGrants,
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
export { remixable, type RemixableRegistration, type RemixableReportOptions } from "./remixable.js";

type ProviderProps = ComponentProps<typeof VendoProvider>;

/** 09-vendo §1 — the UI provider prewired to the default wire base. */
export function VendoRoot(props: Omit<ProviderProps, "client"> & {
  client?: ProviderProps["client"];
  baseUrl?: string;
}): ReturnType<typeof VendoProvider> {
  const { client: configuredClient, baseUrl = "/api/vendo", ...providerProps } = props;
  const defaultClient = useMemo(() => createVendoClient({ baseUrl }), [baseUrl]);
  return <VendoProvider {...providerProps} client={configuredClient ?? defaultClient} />;
}
