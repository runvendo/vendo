#!/usr/bin/env node
/**
 * THE DOORS PROOF — a stock AI SDK agent, no Vendo imports, reaching a live
 * Vendo deployment through the MCP door.
 *
 * Three third-party packages and nothing else: `ai` for the loop,
 * `@ai-sdk/anthropic` for the model, `@modelcontextprotocol/sdk` for the
 * connection. Grep this file for `@vendoai` — there is nothing to find. That is
 * the claim being proved: an outside agent gets the product's tools and
 * `vendo_make` with no SDK, no adapter, and no code of ours in its process.
 *
 * What you should see:
 *   1. the door lists `vendo_make` alongside the product's own tools
 *   2. the model calls it with a plain-language request
 *   3. it gets back a RECEIPT — four fields of words, never a screen
 *   4. it narrates the receipt in its own voice
 *   5. the screen is on the product's page, which this process never touched
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-… \
 *   VENDO_MCP_URL=http://localhost:3000/api/vendo/mcp \
 *   node agent.mjs ["what to ask for"]
 */
import { createHash, randomBytes } from "node:crypto";
import { anthropic } from "@ai-sdk/anthropic";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";

const DOOR = process.env.VENDO_MCP_URL ?? "http://localhost:3000/api/vendo/mcp";
const ASK = process.argv[2] ?? "make me something I can watch this month's spending on";
const EMAIL = process.env.DEMO_EMAIL ?? "yousef@maple.com";
const PASSWORD = process.env.DEMO_PASSWORD ?? "maple-demo";
const REDIRECT = "http://127.0.0.1:43117/callback";

/** Where the product lives, and where its door is mounted inside it — a Vendo
 *  deployment can sit under a path prefix, so the two are derived separately. */
const MOUNT = "/api/vendo/mcp";
const HOST = DOOR.replace(new RegExp(`${MOUNT}/?$`), "");
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const cookiesOf = (response) => response.headers.getSetCookie().map((raw) => raw.split(";")[0]).join("; ");
const field = (html, name) => html.match(new RegExp(`name="${name}"[^>]+value="([^"]+)"`, "i"))?.[1]
  ?.replaceAll("&amp;", "&");

const die = async (stage, response) => {
  console.error(`\n${stage} failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  process.exit(1);
};

/**
 * SIGN IN — the part a real MCP client does in a browser.
 *
 * Claude Code, Cursor and ChatGPT open the door's authorize URL and the person
 * signs in and consents on the product's own pages. This script is headless, so
 * it walks the same three redirects itself: the door bounces to the product's
 * login, the product sets its session and sends us back, and the door's consent
 * page asks the person to allow this client. Nothing here is Vendo-specific
 * except which fields the demo host's login form wants.
 *
 * Everything else is stock RFC 8414 discovery, dynamic client registration and
 * PKCE — the flow every MCP client already implements.
 */
async function bearer() {
  const discovered = await fetch(`${HOST}/.well-known/oauth-authorization-server${MOUNT}`);
  if (!discovered.ok) await die("discovery", discovered);
  const meta = await discovered.json();

  const registered = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "stock-ai-sdk-agent", redirect_uris: [REDIRECT] }),
  });
  if (!registered.ok) await die("register", registered);
  const { client_id: clientId } = await registered.json();

  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const authorize = new URL(meta.authorization_endpoint);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    resource: DOOR,
    state,
  }).toString();

  // 1. the door bounces an unauthenticated authorize to the product's login
  const bounce = await fetch(authorize, { redirect: "manual" });
  const login = new URL(bounce.headers.get("location") ?? "", HOST);
  const returnTo = login.searchParams.get("returnTo");
  if (returnTo === null) await die("authorize bounce", bounce);

  // 2. the product signs the person in and sends them back to the exact request
  const signedIn = await fetch(new URL(login.pathname, HOST), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD, returnTo }),
  });
  const session = cookiesOf(signedIn);
  if (!session.includes("session-token")) await die("sign-in", signedIn);

  // 3. the door's own consent page — "allow this client to act as you"
  const consentUrl = signedIn.headers.get("location");
  const consent = await fetch(consentUrl, { redirect: "manual", headers: { cookie: session } });
  const html = await consent.text();
  const form = html.match(/<form[^>]+action="([^"]+)"/i)?.[1]?.replaceAll("&amp;", "&");
  if (form === undefined) {
    console.error(`\nconsent page did not render a form (${consent.status})`);
    process.exit(1);
  }
  const approved = await fetch(new URL(form, HOST), {
    method: "POST",
    redirect: "manual",
    headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      transaction: field(html, "transaction") ?? "",
      csrf_token: field(html, "csrf_token") ?? "",
      decision: "approve",
    }),
  });
  const callback = new URL(approved.headers.get("location") ?? "", HOST);
  if (callback.searchParams.get("state") !== state) await die("consent", approved);
  const code = callback.searchParams.get("code");

  const issued = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
      resource: DOOR,
    }),
  });
  if (!issued.ok) await die("token", issued);
  return (await issued.json()).access_token;
}

console.log(`door     ${DOOR}`);
const token = await bearer();
console.log(`bearer   ${token.slice(0, 12)}…  (the product's own OAuth: DCR, PKCE, login, consent)`);

const client = new Client({ name: "stock-ai-sdk-agent", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(DOOR), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
}));

/** Every tool the door offers, handed to the loop verbatim. The door's listing
 *  IS the tool set — this script curates nothing and knows no tool by name. */
const { tools: listed } = await client.listTools();
console.log(`listed   ${listed.length} tools, including ${
  listed.some((entry) => entry.name === "vendo_make") ? "vendo_make" : "NO vendo_make"
}\n`);

const receipts = [];
const tools = Object.fromEntries(listed.map((entry) => [entry.name, tool({
  description: entry.description,
  inputSchema: jsonSchema(entry.inputSchema),
  async execute(args) {
    console.log(`→ ${entry.name}(${JSON.stringify(args).slice(0, 300)})`);
    const result = await client.callTool({ name: entry.name, arguments: args });
    const text = (result.content ?? []).map((part) => part.text ?? "").join("");
    console.log(`← ${text.slice(0, 300)}\n`);
    if (entry.name === "vendo_make" && result.isError !== true) receipts.push(text);
    return text;
  },
})]));

console.log(`user     ${ASK}\n`);
const run = streamText({
  model: anthropic("claude-sonnet-4-6"),
  system: "You are an assistant inside a banking product. When an answer would be better looked"
    + " at than read, call vendo_make with a plain-language request, then say the receipt's `say`"
    + " line. You never see the screen and must not describe one.",
  prompt: ASK,
  stopWhen: stepCountIs(4),
  tools,
});

process.stdout.write("agent    ");
for await (const delta of run.textStream) process.stdout.write(delta);
console.log("\n");

await client.close();

// The proof, stated. `receipts` holds exactly what crossed the wire: four
// fields of words. A tree, an island source or a machine ref in there would
// break the receipt law (build contract §3.1), and this says so out loud.
if (receipts.length === 0) {
  console.error("FAIL — the agent never got a receipt from vendo_make");
  process.exit(1);
}
const receipt = JSON.parse(receipts.at(-1));
console.log(`receipt  ${JSON.stringify(receipt)}`);
const leaked = ["tree", "components", "componentTools", "machine", "snapshotRef"]
  .filter((name) => name in receipt);
if (leaked.length > 0) {
  console.error(`FAIL — the receipt carried UI: ${leaked.join(", ")}`);
  process.exit(1);
}
console.log("\nPASS — words to the agent, pixels to the product.");
console.log(`       the screen is at ${HOST}/vendo/apps  (app ${receipt.id})`);
