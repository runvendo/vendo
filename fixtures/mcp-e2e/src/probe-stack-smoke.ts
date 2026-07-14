import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium, type Browser } from "@playwright/test";
import {
  createProbeStack,
  PROBE_MOUNT,
  PROBE_PASSWORD,
  PROBE_RESOURCE_URI,
  PROBE_USERNAME,
  REAL_DOOR_MOUNT,
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

async function connectWithInteractiveOAuth(endpoint: string, browser: Browser): Promise<Client> {
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
  console.log("ENG-277 smoke: real door issued OAuth authorization URL");
  const expectedAuthorization = provider.authorizationUrl.href;
  const page = await browser.newPage();
  let code: string | null = null;
  try {
    await page.route(`${provider.redirectUrl.href}**`, async (route) => {
      await route.fulfill({ status: 200, contentType: "text/html", body: "OAuth callback received" });
    });
    await page.goto(expectedAuthorization);
    const loginUrl = new URL(page.url());
    assert(loginUrl.pathname === "/fixture/login", "real door authorization did not bounce to fixture login");
    assert(loginUrl.searchParams.get("return_to") === expectedAuthorization, "login page changed or truncated return_to");

    await page.getByLabel("Username").fill(PROBE_USERNAME);
    await page.getByLabel("Password").fill(PROBE_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Allow ENG-277 local smoke?" }).waitFor();
    assert(page.url() === expectedAuthorization, "post-login redirect changed the authorization path or query");
    console.log("ENG-277 smoke: interactive login preserved the full authorization URL");

    const callbackRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.origin + url.pathname === provider.redirectUrl.origin + provider.redirectUrl.pathname;
    });
    await page.getByRole("button", { name: "Allow connector" }).click({ noWaitAfter: true });
    const callback = new URL((await callbackRequest).url());
    code = callback.searchParams.get("code");
    assert(callback.searchParams.get("state") === provider.authorizationUrl.searchParams.get("state"), "OAuth callback state mismatch");
    console.log("ENG-277 smoke: consent returned an authorization code and matching state");
  } finally {
    await page.close();
  }
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
  const stack = await createProbeStack({ port: 0 });
  let browser: Browser | undefined;
  let probeClient: Client | undefined;
  let realClient: Client | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const standaloneAuth = new SmokeOAuthProvider();
    probeClient = new Client({ name: "eng-277-probe-smoke", version: "1.0.0" });
    await probeClient.connect(new StreamableHTTPClientTransport(new URL(stack.probeEndpoint), {
      authProvider: standaloneAuth,
    }));
    assert(standaloneAuth.authorizationUrl === undefined, "standalone probe unexpectedly initiated OAuth");
    for (const path of [
      `/.well-known/oauth-protected-resource${PROBE_MOUNT}`,
      `/.well-known/oauth-authorization-server${PROBE_MOUNT}`,
      `${PROBE_MOUNT}/authorize`,
      `${PROBE_MOUNT}/token`,
      `${PROBE_MOUNT}/register`,
    ]) {
      const response = await fetch(`${stack.origin}${path}`, { redirect: "manual" });
      assert(response.status === 404, `standalone no-auth namespace leaked ${path} (${response.status})`);
    }
    const probeAuthPage = await browser.newPage();
    const probeAuthResponse = await probeAuthPage.goto(`${stack.probeEndpoint}/authorize?client_id=must-not-auth`);
    assert(probeAuthResponse?.status() === 404, "standalone probe browser request entered an OAuth login bounce");
    assert(new URL(probeAuthPage.url()).pathname === `${PROBE_MOUNT}/authorize`, "standalone probe auth request redirected");
    await probeAuthPage.close();
    console.log("ENG-277 smoke: standalone endpoint stayed no-auth and its browser flow did not bounce to login");
    const probeTools = await probeClient.listTools();
    const probeTool = probeTools.tools.find((tool) => tool.name === "vendo_jail_probe");
    assert(probeTool?._meta?.["ui/resourceUri"] === PROBE_RESOURCE_URI, "standalone tool omitted MCP Apps resource metadata");
    const probeResource = await probeClient.readResource({ uri: PROBE_RESOURCE_URI });
    const probeContent = probeResource.contents[0];
    assert(probeContent?.mimeType === "text/html;profile=mcp-app", "standalone resource MIME mismatch");
    assert("text" in probeContent && probeContent.text.includes("eval-in-jail"), "standalone probe HTML missing eval-in-jail");
    const probeHtml = probeContent.text;

    realClient = await connectWithInteractiveOAuth(stack.realDoorEndpoint, browser);
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
    console.log("ENG-277 smoke passed: standalone no-auth isolation + interactive OAuth bounce + real generated-component jail");
  } finally {
    await probeClient?.close();
    await realClient?.close();
    await browser?.close();
    await stack.close();
  }
}

await main();
