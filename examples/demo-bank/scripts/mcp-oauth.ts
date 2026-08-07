/**
 * Maple's headless sign-in to its own MCP door — the part a real MCP client
 * does in a browser. Claude Code, Cursor and ChatGPT open the door's authorize
 * URL and the person signs in and consents on Maple's own pages; a script has
 * to walk the same redirects itself.
 *
 * Everything here except the login form's field names is stock RFC 8414
 * discovery, dynamic client registration and PKCE S256. Shared by
 * `mcp-e2e.ts` (the door's own e2e proof) and `mcp-stock-agent.ts` (an agent
 * with no Vendo imports reaching the door), so the dance exists once.
 */
import crypto from "node:crypto";

export type DoorSession = {
  origin: URL;
  /** The door's resource URL — also the OAuth `resource` every request carries. */
  resource: string;
  accessToken: string;
  refreshToken: string | undefined;
  /** Maple's own Auth.js session, for calling the product's routes as the person. */
  cookie: string;
  /** The door's consent page as rendered, for callers that assert on it. */
  consentHtml: string;
  discovery: {
    protectedResource: string;
    authorizationServer: string;
    advertisedResource: string;
  };
};

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function json<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  assert(response.ok, `${label} failed (${response.status}): ${text}`);
  return JSON.parse(text) as T;
}

function htmlAttribute(html: string, element: string, attribute: string): string {
  const match = html.match(new RegExp(`<${element}[^>]+${attribute}="([^"]+)"`, "i"));
  assert(match?.[1], `Consent page omitted ${element}[${attribute}]`);
  return match[1].replaceAll("&amp;", "&").replaceAll("&quot;", '"');
}

function inputValue(html: string, name: string): string {
  const match = html.match(new RegExp(`<input[^>]+name="${name}"[^>]+value="([^"]+)"`, "i"));
  assert(match?.[1], `Consent page omitted ${name}`);
  return match[1].replaceAll("&amp;", "&").replaceAll("&#39;", "'").replaceAll("&quot;", '"');
}

/** The text an MCP tool result carried, concatenated — every caller wants this. */
export function textOf(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const { content } = result as { content?: unknown };
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => (
    item && typeof item === "object"
      && "type" in item && item.type === "text"
      && "text" in item && typeof item.text === "string"
      ? [item.text]
      : []
  )).join("\n");
}

export async function signIn(target: string | undefined, clientName: string): Promise<DoorSession> {
  const origin = new URL(target ?? "http://localhost:3000");
  origin.pathname = "/";
  origin.search = "";
  origin.hash = "";
  const resource = new URL("/api/vendo/mcp", origin).toString();
  const protectedMetadataUrl = new URL(
    "/.well-known/oauth-protected-resource/api/vendo/mcp",
    origin,
  );

  const protectedMetadata = await json<{
    resource: string;
    authorization_servers: string[];
  }>(await fetch(protectedMetadataUrl), "protected-resource discovery");
  assert(protectedMetadata.resource === resource, "Protected-resource metadata advertised the wrong resource.");

  const authorizationServer = protectedMetadata.authorization_servers?.[0];
  assert(authorizationServer, "Protected-resource metadata omitted its authorization server.");
  const authorizationMetadataUrl = new URL(
    `/.well-known/oauth-authorization-server${new URL(resource).pathname}`,
    authorizationServer,
  );
  const authorizationMetadata = await json<{
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
    code_challenge_methods_supported: string[];
  }>(await fetch(authorizationMetadataUrl), "authorization-server discovery");
  assert(authorizationMetadata.code_challenge_methods_supported.includes("S256"), "PKCE S256 was not advertised.");

  const redirectUri = "http://127.0.0.1:43891/callback";
  const registration = await json<{ client_id: string }>(
    await fetch(authorizationMetadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        scope: "maple:read maple:write",
      }),
    }),
    "dynamic client registration",
  );

  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(18).toString("base64url");
  const authorizeUrl = new URL(authorizationMetadata.authorization_endpoint);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "maple:read maple:write",
    resource,
    state,
  }).toString();

  const bounce = await fetch(authorizeUrl, { redirect: "manual" });
  assert(bounce.status === 302, `Authorization did not bounce to Maple login (${bounce.status}).`);
  const loginUrl = new URL(bounce.headers.get("location") ?? "");
  assert(loginUrl.pathname === "/login", "Authorization bounced somewhere other than Maple login.");
  assert(loginUrl.searchParams.get("returnTo") === authorizeUrl.toString(), "Login bounce did not preserve the exact returnTo.");
  const loginPage = await fetch(loginUrl);
  assert(loginPage.ok && (await loginPage.text()).includes("Sign in to Maple"), "Maple login page did not render.");

  const email = process.env.MAPLE_DEMO_EMAIL ?? "yousef@maple.com";
  const password = process.env.MAPLE_DEMO_PASSWORD ?? (origin.hostname === "localhost" ? "maple-demo" : undefined);
  assert(password, "Set MAPLE_DEMO_PASSWORD for non-local runs.");
  const login = await fetch(new URL("/login", origin), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email,
      password,
      returnTo: loginUrl.searchParams.get("returnTo")!,
    }),
  });
  assert(
    login.status >= 302 && login.status <= 308,
    `Maple login failed (${login.status}).`,
  );
  // Auth.js sets its session JWE (and bookkeeping cookies) on the redirect.
  const cookie = login.headers
    .getSetCookie()
    .map((header) => header.split(";", 1)[0]!)
    .find((pair) => pair.includes("authjs.session-token="));
  assert(cookie, "Maple login did not set its Auth.js session cookie.");

  const consentResponse = await fetch(login.headers.get("location")!, {
    redirect: "manual",
    headers: { cookie },
  });
  const consentHtml = await consentResponse.text();
  assert(consentResponse.status === 200, `Default consent page did not render (${consentResponse.status}).`);
  assert(consentHtml.includes(`Allow ${clientName}`), "Default consent page omitted the client name.");

  const approved = await fetch(htmlAttribute(consentHtml, "form", "action"), {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      transaction: inputValue(consentHtml, "transaction"),
      csrf_token: inputValue(consentHtml, "csrf_token"),
      decision: "approve",
    }),
  });
  assert(approved.status === 302, `Consent approval did not redirect (${approved.status}).`);
  const callback = new URL(approved.headers.get("location") ?? "");
  assert(callback.searchParams.get("state") === state, "OAuth state did not round-trip.");
  const code = callback.searchParams.get("code");
  assert(code, "Consent redirect omitted the authorization code.");

  const token = await json<{ access_token: string; refresh_token?: string }>(
    await fetch(authorizationMetadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: registration.client_id,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource,
      }),
    }),
    "authorization-code exchange",
  );

  return {
    origin,
    resource,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    cookie,
    consentHtml,
    discovery: {
      protectedResource: protectedMetadataUrl.toString(),
      authorizationServer: authorizationMetadataUrl.toString(),
      advertisedResource: protectedMetadata.resource,
    },
  };
}
