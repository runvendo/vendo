/**
 * The shared Vendo provider root for the Gmail clone ("Vendo").
 *
 * Wires the client to the server-only agent over HTTP and supplies the
 * component registry (catalog + the app's registered host components), the
 * client-executed host tools (ENG-202 topology B: approved calls run in the
 * user's browser on their session), the store, and the brand.
 * All surfaces sharing a threadId share one conversation.
 */
import React, { useMemo } from "react";
import { DefaultChatTransport } from "ai";
import { VendoProvider } from "@vendoai/react";
import { VendoShellProvider, createWebStorage } from "@vendoai/shell";
import {
  prewiredComponents,
  VendoThemeProvider,
  brandToCssVars,
  brandTokensSchema,
} from "@vendoai/components";
import { gmailHostComponents } from "./host-components";
import { gmailHostToolDefs } from "./host-tools";
import { renderNode } from "./render-node";
import { runQuery } from "./run-query";
import brandJson from "./brand.json";

const brand = brandTokensSchema.parse(brandJson);
const registry = [...prewiredComponents, ...gmailHostComponents];

// One module-scope store so every surface shares saved vendos.
const store = createWebStorage({ namespace: "gmail-demo" });

export function VendoRoot({ children, threadId = "gmail-demo" }) {
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/vendo/chat" }),
    [],
  );

  return (
    <VendoProvider
      transport={transport}
      components={registry}
      threadId={threadId}
      hostTools={{ definitions: gmailHostToolDefs }}
    >
      <VendoThemeProvider brand={brand}>
        <VendoShellProvider
          renderNode={renderNode}
          store={store}
          runQuery={runQuery}
          // Same registry as VendoProvider — reopened saved views diff their
          // host-component stamp against it and surface drift (ENG-186).
          components={registry}
          theme={{ scheme: "light" }}
          cssVars={brandToCssVars(brand)}
          productName="Vendo"
        >
          {children}
        </VendoShellProvider>
      </VendoThemeProvider>
    </VendoProvider>
  );
}
