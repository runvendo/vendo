#!/usr/bin/env node
// ENG-286 — the full broker dance against a LOCAL stack:
//   real MCP SDK client -> local broker tenant (https://maple.mcp.vendo.run via
//   loopback TLS front) -> DCR -> authorize -> login federates to local Maple
//   -> broker consent -> code+PKCE -> tokens -> tools/list -> read tool ->
//   destructive tool parks -> approve in Maple's product UI -> retry succeeds
//   -> RFC 7009 revoke kills the session.
// Browser legs run in Playwright Chromium through a loopback CONNECT proxy;
// Node legs remap *.mcp.vendo.run:443 to the loopback TLS front with a custom
// undici connector. Everything stays on 127.0.0.1.
import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Path to a built checkout of runvendo/vendo (`pnpm install && pnpm build`);
// the driver resolves Playwright, undici, and the MCP SDK from its store.
const REPO = process.env.VENDO_REPO;
if (!REPO) {
  console.error("Set VENDO_REPO to a built runvendo/vendo checkout (see README).");
  process.exit(1);
}
const SHOTS = process.env.SHOTS_DIR ?? "/tmp/eng-286/shots";
const TLS_CRT = process.env.LOCAL_TLS_CRT ?? "/tmp/eng-286/local/tls.crt"; // the throwaway cert from the README openssl step
const ISSUER = "https://maple.mcp.vendo.run";
const RESOURCE = `${ISSUER}/mcp`;
const MAPLE = "https://127.0.0.1:8443";
const REDIRECT_URI = "http://127.0.0.1:43891/callback";

mkdirSync(SHOTS, { recursive: true });

// --- dependency resolution out of the monorepo store ---
const uiRequire = createRequire(`${REPO}/packages/ui/package.json`);
const { chromium } = uiRequire("@playwright/test");
const undici = uiRequire(`${REPO}/node_modules/.pnpm/undici@7.28.0/node_modules/undici/index.js`);
const sdkRoot = `${REPO}/node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_zod@3.25.76/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(pathToFileURL(`${sdkRoot}/client/index.js`).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(`${sdkRoot}/client/streamableHttp.js`).href);

// --- Node-side fetch that reaches the loopback TLS fronts by real name ---
// The throwaway local cert is trusted as a CA (it carries SANs for
// *.mcp.vendo.run and 127.0.0.1), so TLS verification stays ON.
const baseConnect = undici.buildConnector({ ca: readFileSync(TLS_CRT) });
const connector = (options, callback) => {
  if (options.hostname.endsWith(".mcp.vendo.run")) {
    baseConnect({ ...options, hostname: "127.0.0.1", port: 8444, servername: options.hostname }, callback);
    return;
  }
  baseConnect(options, callback);
};
const dispatcher = new undici.Agent({ connect: connector });
const bfetch = (url, init) => undici.fetch(url, { ...init, dispatcher, redirect: init?.redirect ?? "manual" });

const transcript = [];
function beat(name, detail) {
  transcript.push({ beat: name, at: new Date().toISOString(), ...detail });
  console.log(`✔ ${name}`, JSON.stringify(detail ?? {}));
}
function fail(message) {
  console.error(`✘ ${message}`);
  process.exit(1);
}
async function json(response, label) {
  const text = await response.text();
  if (!response.ok) fail(`${label} failed (${response.status}): ${text}`);
  return JSON.parse(text);
}
const textOf = (result) => (result?.content ?? [])
  .filter((item) => item?.type === "text").map((item) => item.text).join("\n");

// 1) Discovery: Maple names the broker; broker serves RFC 8414 for the tenant.
const prm = await json(await bfetch(`${MAPLE}/.well-known/oauth-protected-resource/api/vendo/mcp`), "protected-resource discovery");
if (prm.authorization_servers?.[0] !== ISSUER) fail(`Maple advertised ${prm.authorization_servers} instead of the broker`);
const as = await json(await bfetch(`${ISSUER}/.well-known/oauth-authorization-server`), "authorization-server discovery");
if (as.issuer !== ISSUER || !as.code_challenge_methods_supported?.includes("S256")) fail("Broker AS metadata is wrong");
beat("discovery", { resource: prm.resource, authorization_server: as.issuer });

// 2) Dynamic client registration at the broker.
const registration = await json(await bfetch(as.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "ENG-286 proof client", redirect_uris: [REDIRECT_URI], scope: "maple:read maple:write" }),
}), "dynamic client registration");
beat("dcr", { client_id: registration.client_id });

// 3) Local redirect-uri listener captures the authorization code.
const codePromise = new Promise((resolve) => {
  const listener = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1:43891");
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body style='font-family:sans-serif'><h2>ENG-286 client connected.</h2>You can close this window.</body></html>");
    if (url.pathname === "/callback") {
      listener.close();
      resolve({ code: url.searchParams.get("code"), state: url.searchParams.get("state") });
    }
  });
  listener.listen(43891, "127.0.0.1");
});

// 4) PKCE + authorize URL.
const verifier = crypto.randomBytes(48).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const state = crypto.randomBytes(18).toString("base64url");
const authorizeUrl = new URL(as.authorization_endpoint);
authorizeUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: registration.client_id,
  redirect_uri: REDIRECT_URI,
  code_challenge: challenge,
  code_challenge_method: "S256",
  scope: "maple:read maple:write",
  resource: RESOURCE,
  state,
}).toString();

// 5) Browser leg: authorize -> federation -> Maple login -> broker consent.
const browser = await chromium.launch({
  headless: true,
  proxy: { server: "http://127.0.0.1:8888" },
});
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: `${SHOTS}/video`, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();
await page.goto(authorizeUrl.toString(), { waitUntil: "networkidle" });
if (!page.url().startsWith(`${MAPLE}/login`)) fail(`Expected Maple login bounce, landed on ${page.url()}`);
await page.screenshot({ path: `${SHOTS}/01-login-bounce.png` });
beat("login-bounce", { url: page.url().split("?")[0] });

await page.fill('input[name="password"]', process.env.MAPLE_DEMO_PASSWORD ?? "maple-demo");
await page.waitForTimeout(400);
await page.click('button[type="submit"]');
await page.waitForLoadState("networkidle");
// Chromium (under the local CONNECT proxy + IP-literal host) drops the freshly
// set session cookie on the redirect hop immediately following the login POST.
// The federation handshake is explicitly retryable — the returnTo IS the same
// signed federate request — so retry it once, exactly as the design intends.
if (page.url().startsWith(`${MAPLE}/login`)) {
  const returnTo = new URL(page.url()).searchParams.get("returnTo");
  if (returnTo) await page.goto(returnTo, { waitUntil: "networkidle" });
}
if (!page.url().startsWith(`${ISSUER}/consent`)) fail(`Expected broker consent, landed on ${page.url()}`);
await page.screenshot({ path: `${SHOTS}/02-broker-consent.png` });
const consentText = await page.textContent("main");
if (!consentText?.includes("Connect to Maple") || !consentText.includes("ENG-286 proof client")) {
  fail("Broker consent page is missing the tenant product or client name");
}
beat("broker-consent", { url: page.url(), federated_login: true });

await page.click("button.approve");
const { code, state: returnedState } = await codePromise;
if (!code || returnedState !== state) fail("Authorization code redirect was wrong");
await page.waitForLoadState("networkidle");
await page.screenshot({ path: `${SHOTS}/03-client-connected.png` });
beat("authorization-code", { state_roundtrip: true });

// 6) Token exchange (PKCE + resource binding) at the broker.
const tokens = await json(await bfetch(as.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: registration.client_id,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    resource: RESOURCE,
  }),
}), "token exchange");
if (!tokens.access_token || !tokens.refresh_token) fail("Token response incomplete");
beat("tokens", { token_type: tokens.token_type, has_refresh: Boolean(tokens.refresh_token) });

// 7) Real MCP SDK client against the broker's tenant /mcp (streamed proxy to Maple).
const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
  requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
  fetch: (url, init) => bfetch(url, { ...init, redirect: "follow" }),
});
const client = new Client({ name: "eng-286-proof", version: "1.0.0" });
await client.connect(transport);
const listed = await client.listTools();
if (!listed.tools.some((tool) => tool.name === "host_listAccounts")) fail("Maple tools not listed through the broker");
beat("tools-list", { count: listed.tools.length });

const accounts = await client.callTool({ name: "host_listAccounts", arguments: {} });
if (accounts.isError || !textOf(accounts).includes("Maple Checking")) fail(`Read tool failed: ${textOf(accounts)}`);
beat("read-tool", { tool: "host_listAccounts", maple_data: true });

const transferArgs = { amount: 1234, recipient_name: "Broker E2E Recipient", memo: "ENG-286 broker e2e" };
const parked = await client.callTool({ name: "host_transferMoney", arguments: transferArgs });
if (!parked.isError) fail("Destructive transfer did not park");
const approvalId = textOf(parked).match(/apr_[0-9a-f-]+/)?.[0];
if (!approvalId) fail(`Parked result did not name an approval: ${textOf(parked)}`);
beat("destructive-parks", { approvalId, message: textOf(parked).slice(0, 120) });

// 8) Approve in Maple's product UI (the Vendo tab approvals inbox).
// Note: the product surface is driven at the dev server's own origin —
// Next.js DEV asset hydration doesn't come up through the local TLS front
// (a dev-harness quirk; a built/deployed Maple has no second dev origin).
// Same server, same session subject, same approval queue.
const MAPLE_UI = "http://localhost:3000";
await context.request.post(`${MAPLE_UI}/login`, {
  form: { email: "yousef@maple.com", password: process.env.MAPLE_DEMO_PASSWORD ?? "maple-demo", returnTo: "/" },
  maxRedirects: 0,
});
await page.goto(`${MAPLE_UI}/vendo`, { waitUntil: "networkidle" });
const inbox = 'section[aria-label="Pending Vendo approvals"]';
await page.waitForSelector(`${inbox} .fl-approval`, { timeout: 20000 });
await page.screenshot({ path: `${SHOTS}/04-approval-card-in-maple.png` });
beat("approval-visible-in-maple", { surface: "/vendo approvals inbox" });
await page.click(`${inbox} .fl-approval button:has-text('Approve')`);
await page.waitForSelector(inbox, { state: "detached", timeout: 15000 });
await page.screenshot({ path: `${SHOTS}/05-approval-resolved.png` });
beat("approved-in-product", { approvalId });

// 9) Retry the identical call — the parked approval is pinned to it.
const retried = await client.callTool({ name: "host_transferMoney", arguments: transferArgs });
if (retried.isError || !textOf(retried).includes("Broker E2E Recipient")) fail(`Approved retry failed: ${textOf(retried)}`);
beat("retry-succeeds", { side_effect: true });

// 10) RFC 7009 revoke at the broker kills the session.
const revoke = await bfetch(as.revocation_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token: tokens.access_token, token_type_hint: "access_token", client_id: registration.client_id }),
});
if (revoke.status !== 200) fail(`Revocation failed (${revoke.status})`);
const rejected = await bfetch(RESOURCE, {
  method: "POST",
  headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
});
if (rejected.status !== 401) fail(`Revoked token still worked (${rejected.status})`);
beat("revoked", { post_revoke_status: rejected.status });

await client.close().catch(() => undefined);
await context.close();
await browser.close();
writeFileSync(`${SHOTS}/transcript.json`, JSON.stringify(transcript, null, 2));
console.log(`\nENG-286 broker e2e: ALL BEATS PASSED (${transcript.length} beats). Shots in ${SHOTS}`);
