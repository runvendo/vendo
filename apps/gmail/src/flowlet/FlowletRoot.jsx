/**
 * The shared Flowlet provider root for the Gmail clone ("Vendo").
 *
 * Wires the client to the server-only agent over HTTP and supplies the
 * component registry (catalog + the app's registered host components), the
 * client-executed host tools (ENG-202 topology B: approved calls run in the
 * user's browser on their session), the store, and the brand.
 * All surfaces sharing a threadId share one conversation.
 */
import React, { useMemo } from "react";
import { DefaultChatTransport } from "ai";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider, createWebStorage } from "@flowlet/shell";
import {
  prewiredComponents,
  FlowletThemeProvider,
  brandToCssVars,
  brandTokensSchema,
} from "@flowlet/components";
import { gmailHostComponents } from "./host-components";
import { gmailHostToolDefs } from "./host-tools";
import { renderNode } from "./render-node";
import { runQuery } from "./run-query";
import brandJson from "./brand.json";

const brand = brandTokensSchema.parse(brandJson);
const registry = [...prewiredComponents, ...gmailHostComponents];

// One module-scope store so every surface shares saved flowlets.
const store = createWebStorage({ namespace: "gmail-demo" });

export function FlowletRoot({ children, threadId = "gmail-demo" }) {
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/flowlet/chat" }),
    [],
  );

  return (
    <FlowletProvider
      transport={transport}
      components={registry}
      threadId={threadId}
      hostTools={{ definitions: gmailHostToolDefs }}
    >
      <FlowletThemeProvider brand={brand}>
        <FlowletShellProvider
          renderNode={renderNode}
          store={store}
          runQuery={runQuery}
          // Same registry as FlowletProvider — reopened saved views diff their
          // host-component stamp against it and surface drift (ENG-186).
          components={registry}
          theme={{ scheme: "light" }}
          cssVars={brandToCssVars(brand)}
          productName="Vendo"
        >
          {children}
        </FlowletShellProvider>
      </FlowletThemeProvider>
    </FlowletProvider>
  );
}
