import type { Json, UIPayload } from "@vendoai/core";
import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { VendoProvider } from "../../context.js";
import { ContainedNotice } from "../notice.js";
import { PayloadView } from "../renderer.js";
import { HttpOpenCard } from "./http-open-card.js";
import { createShimRuntime, type OpenInProductPayload, type ShimRuntime } from "./shim-core.js";
import { readThemeCssVariables } from "./theme.js";

const mount = document.querySelector<HTMLElement>("#vendo-mcp-shim");
if (!mount) throw new Error("The MCP Apps shim mount is missing");

const root = createRoot(mount);
const theme = readThemeCssVariables(getComputedStyle(document.documentElement));
const bridge = new App(
  { name: "Vendo tree renderer", version: "0.3.0" },
  {},
  { autoResize: true, strict: true },
);

function renderWithTheme(children: ReactNode): void {
  root.render(<VendoProvider theme={theme}>{children}</VendoProvider>);
}

function renderNotice(label: string, message: string): void {
  renderWithTheme(<ContainedNotice label={label}>{message}</ContainedNotice>);
}

function renderOpenInProduct(open: OpenInProductPayload): void {
  renderWithTheme(<HttpOpenCard open={open} />);
}

let runtime: ShimRuntime;

function renderPayload(
  id: string,
  payload: UIPayload,
  data?: Record<string, Json>,
  queryErrors: string[] = [],
): void {
  renderWithTheme(
    <>
      <PayloadView
        payload={payload}
        components={{}}
        data={data}
        onAction={({ action, payload: args }) => runtime.callApp(id, action, args ?? {})}
      />
      {queryErrors.map((message, index) => (
        <ContainedNotice key={`${index}:${message}`} label="Data query error">
          {message}
        </ContainedNotice>
      ))}
    </>,
  );
}

runtime = createShimRuntime({
  callServerTool: (request) => bridge.callServerTool(request),
  renderPayload,
  renderOpenInProduct,
  renderNotice,
});

bridge.ontoolinput = ({ arguments: args }) => {
  runtime.onToolInput(args);
};

bridge.ontoolresult = (result) => {
  runtime.onToolResult(result);
};

renderNotice("Loading app", "Waiting for the MCP host to send the app payload.");
bridge.connect(new PostMessageTransport(window.parent, window.parent)).catch((error: unknown) => {
  renderNotice("MCP host connection failed", error instanceof Error ? error.message : String(error));
});
