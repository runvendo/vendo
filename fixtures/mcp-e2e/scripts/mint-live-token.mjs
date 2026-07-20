#!/usr/bin/env node
/** Mints an MCP door access token over the door's own OAuth wire, for the
 * nightly live-Claude leg. `claude -p` (non-interactive) cannot complete an
 * MCP OAuth browser dance, so CI performs the standard flow itself — dynamic
 * client registration, PKCE S256 authorize (the live fixture's auto-approve
 * HostOAuthAdapter answers consent), code exchange — and hands Claude the
 * resulting bearer via `claude mcp add --header`. This exercises the real
 * DCR/authorize/token endpoints end to end; nothing is stubbed.
 *
 * Usage: node scripts/mint-live-token.mjs <door-endpoint>
 * Prints the access token on stdout.
 */
import { createHash, randomBytes } from "node:crypto";

const endpoint = process.argv[2];
if (!endpoint) {
  console.error("usage: mint-live-token.mjs <door-endpoint>");
  process.exit(2);
}

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const redirectUri = "http://127.0.0.1:43117/callback";

const fail = async (stage, response) => {
  console.error(`${stage} failed (${response.status}): ${await response.text()}`);
  process.exit(1);
};

const metadataUrl = new URL(endpoint);
metadataUrl.pathname = `/.well-known/oauth-authorization-server${metadataUrl.pathname}`;
const metadataResponse = await fetch(metadataUrl);
if (!metadataResponse.ok) await fail("metadata", metadataResponse);
const metadata = await metadataResponse.json();

const registration = await fetch(metadata.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "nightly-live-claude", redirect_uris: [redirectUri] }),
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
const authorize = await fetch(authorizeUrl, { redirect: "manual" });
const location = authorize.headers.get("location");
if (authorize.status !== 302 || !location) await fail("authorize", authorize);
const code = new URL(location).searchParams.get("code");
const authorizeError = new URL(location).searchParams.get("error");
if (!code) {
  console.error(`authorize did not return a code: ${authorizeError ?? location}`);
  process.exit(1);
}

const token = await fetch(metadata.token_endpoint, {
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
if (!token.ok) await fail("token", token);
const { access_token: accessToken } = await token.json();
if (!accessToken) {
  console.error("token response carried no access_token");
  process.exit(1);
}
process.stdout.write(accessToken);
