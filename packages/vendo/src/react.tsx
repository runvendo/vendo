"use client";

import { createVendoClient, VendoProvider } from "@vendoai/ui";
import { useMemo, type ComponentProps } from "react";

export * from "@vendoai/ui";
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
