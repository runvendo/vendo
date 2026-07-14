import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "@playwright/test";
import {
  createProbeStack,
  PROBE_RESOURCE_URI,
  REAL_JAIL_APP_ID,
} from "./probe-stack.js";

type ClientInformation = Parameters<NonNullable<OAuthClientProvider["saveClientInformation"]>>[0];
type Tokens = Parameters<OAuthClientProvider["saveTokens"]>[0];

class SmokeOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  information?: ClientInformation;
  savedTokens?: Tokens;
  verifier?: string;

  get redirectUrl(): URL { return new URL("http://127.0.0.1/probe-smoke-callback"); }
  get clientMetadata() {
    return {
      client_name: "ENG-277 local smoke",
      redirect_uris: [this.redirectUrl.href],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "read write",
    };
  }
  clientInformation(): ClientInformation | undefined { return this.information; }
  saveClientInformation(value: ClientInformation): void { this.information = value; }
  tokens(): Tokens | undefined { return this.savedTokens; }
  saveTokens(value: Tokens): void { this.savedTokens = value; }
  redirectToAuthorization(value: URL): void { this.authorizationUrl = value; }
  saveCodeVerifier(value: string): void { this.verifier = value; }
  codeVerifier(): string {
    if (!this.verifier) throw new Error("SDK did not persist a PKCE verifier");
    return this.verifier;
  }
}

async function connectWithOAuth(endpoint: string): Promise<Client> {
  const provider = new SmokeOAuthProvider();
  const firstTransport = new StreamableHTTPClientTransport(new URL(endpoint), { authProvider: provider });
  const firstClient = new Client({ name: "eng-277-smoke", version: "1.0.0" });
  try {
    await firstClient.connect(firstTransport);
    throw new Error("real door unexpectedly skipped OAuth");
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
  }
  if (!provider.authorizationUrl) throw new Error("SDK did not produce an authorization URL");
  const authorization = await fetch(provider.authorizationUrl, { redirect: "manual" });
  const location = authorization.headers.get("location");
  if (authorization.status !== 302 || !location) throw new Error("auto authorization did not return a code redirect");
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error("authorization redirect omitted code");
  await firstTransport.finishAuth(code);
  await firstTransport.close();

  const transport = new StreamableHTTPClientTransport(new URL(endpoint), { authProvider: provider });
  const client = new Client({ name: "eng-277-smoke", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const stack = await createProbeStack({ port: 0, autoAuthorize: true });
  let probeClient: Client | undefined;
  let realClient: Client | undefined;
  try {
    probeClient = new Client({ name: "eng-277-probe-smoke", version: "1.0.0" });
    await probeClient.connect(new StreamableHTTPClientTransport(new URL(stack.probeEndpoint)));
    const probeTools = await probeClient.listTools();
    const probeTool = probeTools.tools.find((tool) => tool.name === "vendo_jail_probe");
    assert(probeTool?._meta?.["ui/resourceUri"] === PROBE_RESOURCE_URI, "standalone tool omitted MCP Apps resource metadata");
    const probeResource = await probeClient.readResource({ uri: PROBE_RESOURCE_URI });
    const probeContent = probeResource.contents[0];
    assert(probeContent?.mimeType === "text/html;profile=mcp-app", "standalone resource MIME mismatch");
    assert("text" in probeContent && probeContent.text.includes("eval-in-jail"), "standalone probe HTML missing eval-in-jail");
    const probeHtml = probeContent.text;

    realClient = await connectWithOAuth(stack.realDoorEndpoint);
    const realTools = await realClient.listTools();
    const openTool = realTools.tools.find((tool) => tool.name === "vendo_apps_open");
    assert(openTool?._meta?.["ui/resourceUri"] === "ui://vendo/tree-shim.html", "real door omitted shim metadata");
    const opened = await realClient.callTool({ name: "vendo_apps_open", arguments: { appId: REAL_JAIL_APP_ID } });
    const payload = opened.structuredContent;
    assert(payload && typeof payload === "object" && (payload as { components?: unknown }).components, "real door payload omitted generated component source");
    const shimResource = await realClient.readResource({ uri: "ui://vendo/tree-shim.html" });
    const shimContent = shimResource.contents[0];
    assert(shimContent && "text" in shimContent, "real door did not serve the real shim HTML");
    const shimHtml = shimContent.text;

    const browser = await chromium.launch({ headless: true });
    try {
      const capabilityPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await capabilityPage.setContent(probeHtml);
      for (const id of ["eval-direct", "new-function", "srcdoc-1", "srcdoc-2", "postmessage-cross", "eval-in-jail"]) {
        await capabilityPage.locator(`#${id}[data-status="pass"]`).waitFor({ state: "visible", timeout: 10_000 });
      }
      await capabilityPage.close();

      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.setContent(`<!doctype html><iframe id="shim-frame" title="Vendo MCP Apps shim"></iframe><script>
        const payload = ${JSON.stringify(payload)};
        window.addEventListener("message", (event) => {
          const message = event.data;
          if (!message || message.jsonrpc !== "2.0") return;
          if (message.method === "ui/initialize") {
            event.source.postMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "eng-277-smoke", version: "1" }, hostCapabilities: { serverTools: {} }, hostContext: {} } }, "*");
          } else if (message.method === "ui/notifications/initialized") {
            event.source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { appId: "${REAL_JAIL_APP_ID}" } } }, "*");
            event.source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload } }, "*");
          }
        });
      <\/script>`);
      await page.locator("#shim-frame").evaluate((frame, html) => {
        (frame as unknown as { srcdoc: string }).srcdoc = html;
      }, shimHtml);
      const jailed = page.frameLocator("#shim-frame")
        .frameLocator('iframe[title="Generated component: JailProbeCard"]')
        .frameLocator('iframe[title="Generated Vendo component"]');
      await jailed.getByText("REAL VENDO JAIL: PASS").waitFor({ state: "visible", timeout: 15_000 });
      await jailed.getByRole("button", { name: "Exercise jailed React" }).click();
      await jailed.getByText("Jail interactions: 1").waitFor({ state: "visible" });
    } finally {
      await browser.close();
    }
    console.log("ENG-277 smoke passed: standalone MCP App + OAuth door + real generated-component jail");
  } finally {
    await probeClient?.close();
    await realClient?.close();
    await stack.close();
  }
}

await main();
