#!/usr/bin/env node
/**
 * Proves Maple's curated MCP door over its OWN wire: the tools an MCP client
 * actually sees are exactly `.vendo/overrides.json`'s `surfaces.mcp` list, each
 * carrying its human title and risk-derived annotations.
 *
 * Nothing is stubbed. The script performs the real OAuth dance against a
 * running demo-bank — dynamic client registration, PKCE S256 authorize
 * (carrying a real Auth.js session cookie so the door's host-session check
 * passes and consent auto-approves), code exchange — then speaks Streamable
 * HTTP MCP (initialize + tools/list) with the bearer it earned.
 *
 * Usage: node scripts/assert-curated-mcp-menu.mjs [base-url]
 *   base-url defaults to http://127.0.0.1:3457
 * Exit 0 = the door's menu matches the authored file exactly.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { encode } from "next-auth/jwt";

const base = (process.argv[2] ?? "http://127.0.0.1:3457").replace(/\/+$/, "");
const endpoint = `${base}/api/vendo/mcp`;
const appDir = fileURLToPath(new URL("..", import.meta.url));
const COOKIE_NAME = "authjs.session-token";
const SEEDED_SUBJECT = "vendo-demo";
const DEV_SECRET = "maple-local-development-auth-secret";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const fail = async (stage, response) => {
  console.error(`FAIL ${stage} (${response.status}): ${(await response.text()).slice(0, 400)}`);
  process.exit(1);
};
const die = (message) => {
  console.error(`FAIL ${message}`);
  process.exit(1);
};

// ---- what the authored file says the menu is ---------------------------------
const overrides = JSON.parse(await readFile(`${appDir}/.vendo/overrides.json`, "utf8"));
const expected = overrides.surfaces?.mcp?.tools;
if (!Array.isArray(expected) || expected.length === 0) die("no surfaces.mcp list in .vendo/overrides.json");
const expectedTitles = Object.fromEntries(
  expected.map((name) => [name, overrides.tools?.[name]?.title]),
);
const extracted = JSON.parse(await readFile(`${appDir}/.vendo/tools.json`, "utf8"));
// The MERGED risk, the way the registry's mergeOverride resolves it — an
// override's `risk` is what the door annotates from, so reading tools.json
// alone measures a grade the wire never carried.
const riskByName = Object.fromEntries(
  extracted.tools.map((tool) => [tool.name, overrides.tools?.[tool.name]?.risk ?? tool.risk]),
);

// ---- earn a bearer over the door's real OAuth wire ---------------------------
const cookie = `${COOKIE_NAME}=${await encode({
  token: { sub: SEEDED_SUBJECT },
  secret: process.env.AUTH_SECRET ?? DEV_SECRET,
  salt: COOKIE_NAME,
  maxAge: 300,
})}`;

const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const redirectUri = "http://127.0.0.1:43117/callback";

const metadataUrl = new URL(endpoint);
metadataUrl.pathname = `/.well-known/oauth-authorization-server${metadataUrl.pathname}`;
const metadataResponse = await fetch(metadataUrl);
if (!metadataResponse.ok) await fail("metadata", metadataResponse);
const metadata = await metadataResponse.json();

const registration = await fetch(metadata.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "curated-menu-proof", redirect_uris: [redirectUri] }),
});
if (!registration.ok) await fail("register", registration);
const { client_id: clientId } = await registration.json();

const authorizeUrl = new URL(metadata.authorization_endpoint);
authorizeUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirectUri,
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource: endpoint,
  state: b64url(randomBytes(16)),
}).toString();
let authorize = await fetch(authorizeUrl, { redirect: "manual", headers: { cookie } });
// Interactive consent: the door renders its page, we post the decision back
// with the same session + CSRF token, exactly as the browser would.
if (authorize.status === 200) {
  const page = await authorize.text();
  const field = (name) => page.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
  const action = page.match(/<form method="post" action="([^"]+)"/)?.[1];
  const transaction = field("transaction");
  const csrf = field("csrf_token");
  if (!action || !transaction || !csrf) die("consent page did not carry a postable decision form");
  authorize = await fetch(new URL(action, endpoint), {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction, csrf_token: csrf, decision: "approve" }),
  });
}
const location = authorize.headers.get("location");
if (!location) await fail("authorize", authorize);
const code = new URL(location, endpoint).searchParams.get("code");
if (!code) die(`authorize returned no code: ${location}`);

const tokenResponse = await fetch(metadata.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: endpoint,
  }),
});
if (!tokenResponse.ok) await fail("token", tokenResponse);
const { access_token: accessToken } = await tokenResponse.json();
if (!accessToken) die("token response carried no access_token");

// ---- speak MCP ---------------------------------------------------------------
const rpc = async (body, sessionId) => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) await fail(`rpc ${body.method}`, response);
  const text = await response.text();
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? JSON.parse(text.split("\n").find((line) => line.startsWith("data: ")).slice(6))
    : JSON.parse(text);
  return { payload, sessionId: response.headers.get("mcp-session-id") ?? sessionId };
};

const initialized = await rpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "curated-menu-proof", version: "1.0.0" },
  },
});
const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, initialized.sessionId);
const tools = listed.payload.result?.tools;
if (!Array.isArray(tools)) die(`tools/list returned no tools: ${JSON.stringify(listed.payload).slice(0, 300)}`);

// ---- assert -----------------------------------------------------------------
const problems = [];
// Vendo's own runtime ride-alongs are never curated away (they are the
// product's plumbing, not Maple's API), so the host surface is what we compare.
const hostTools = tools.filter((tool) => !tool.name.startsWith("vendo_"));
// Set equality, not sequence: the door FILTERS its bound surface, so listings
// keep the registry's order rather than the authored file's. The menu decides
// WHICH tools a client sees; the order they arrive in is not part of the
// contract (and no client presents them in wire order anyway).
const listedNames = hostTools.map((tool) => tool.name);
if (JSON.stringify([...listedNames].sort()) !== JSON.stringify([...expected].sort())) {
  const missing = expected.filter((name) => !listedNames.includes(name));
  const extra = listedNames.filter((name) => !expected.includes(name));
  problems.push(
    `menu mismatch\n  missing from the door: ${missing.join(", ") || "none"}`
    + `\n  listed but not curated: ${extra.join(", ") || "none"}`,
  );
}
for (const tool of hostTools) {
  const title = expectedTitles[tool.name];
  if (title && tool.title !== title) problems.push(`${tool.name}: title "${tool.title}" != "${title}"`);
  if (title && tool.annotations?.title !== title) problems.push(`${tool.name}: annotations.title missing`);
  const risk = riskByName[tool.name];
  // An `ungraded` tool asserts NEITHER hint: MCP's default for
  // `destructiveHint` is `true`, so `false` would claim safety about a tool
  // nobody graded. Absent is the answer, and this measures that it is absent.
  const readOnly = risk === "ungraded" ? undefined : risk === "read";
  const destructive = risk === "ungraded" ? undefined : risk === "destructive";
  if (tool.annotations?.readOnlyHint !== readOnly) problems.push(`${tool.name}: readOnlyHint != ${readOnly} (risk ${risk})`);
  if (tool.annotations?.destructiveHint !== destructive) problems.push(`${tool.name}: destructiveHint != ${destructive} (risk ${risk})`);
}
const rideAlongs = tools.filter((tool) => tool.name.startsWith("vendo_")).map((tool) => tool.name);

// Curation is not security: a curated menu must not have quietly become the
// thing that stops dangerous calls. The destructive tool IS on the menu, so
// calling it has to reach the guard and park under Maple's own ask policy.
const called = await rpc({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "host_transferMoney", arguments: { payeeId: "pye_1", amountCents: 1000 } },
}, initialized.sessionId);
const callText = JSON.stringify(called.payload.result ?? called.payload);
if (!/needs approval|approvals queue/i.test(callText)) {
  problems.push(`destructive call was not parked by the guard: ${callText.slice(0, 300)}`);
}

// …and an off-menu tool answers exactly like a tool that does not exist.
const offMenu = await rpc({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: { name: "host_getProfile", arguments: {} },
}, initialized.sessionId);
const offMenuText = JSON.stringify(offMenu.payload.result ?? offMenu.payload);
if (!/not-found/.test(offMenuText)) {
  problems.push(`off-menu call did not answer not-found: ${offMenuText.slice(0, 300)}`);
}

if (problems.length > 0) {
  console.error(`FAIL curated menu\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`PASS door lists exactly the curated ${hostTools.length}-tool menu`);
console.log("PASS the destructive tool still parks at the guard; an off-menu call is a plain not-found");
for (const tool of hostTools) {
  const hints = `readOnly=${tool.annotations.readOnlyHint} destructive=${tool.annotations.destructiveHint}`;
  console.log(`  ${tool.name.padEnd(30)} ${String(tool.title).padEnd(32)} ${hints}`);
}
console.log(`  (+ never-curated Vendo ride-alongs: ${rideAlongs.join(", ") || "none"})`);
