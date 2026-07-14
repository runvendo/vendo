import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

interface EndpointStack {
  endpoint: string;
}

export const REDIRECT_URI = "http://127.0.0.1/callback";
export const VERIFIER = "mcp-e2e-verifier-with-enough-entropy-1234567890-abcdefghijklmnop";

type ClientInformation = Parameters<NonNullable<OAuthClientProvider["saveClientInformation"]>>[0];
type Tokens = Parameters<OAuthClientProvider["saveTokens"]>[0];

export class TestOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  information?: ClientInformation;
  savedTokens?: Tokens;
  verifier?: string;

  get redirectUrl(): URL {
    return new URL(REDIRECT_URI);
  }

  get clientMetadata() {
    return {
      client_name: "Vendo MCP e2e",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "read write",
    };
  }

  clientInformation(): ClientInformation | undefined {
    return this.information;
  }

  saveClientInformation(clientInformation: ClientInformation): void {
    this.information = clientInformation;
  }

  tokens(): Tokens | undefined {
    return this.savedTokens;
  }

  saveTokens(tokens: Tokens): void {
    this.savedTokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("SDK did not save a PKCE verifier");
    return this.verifier;
  }
}

export interface ConnectedClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
  provider: TestOAuthProvider;
  requests: URL[];
  close(): Promise<void>;
}

export async function connectWithSdk(stack: EndpointStack): Promise<ConnectedClient> {
  const provider = new TestOAuthProvider();
  const requests: URL[] = [];
  const trackedFetch: typeof fetch = async (input, init) => {
    requests.push(new URL(input instanceof Request ? input.url : input));
    return fetch(input, init);
  };
  const firstTransport = new StreamableHTTPClientTransport(new URL(stack.endpoint), {
    authProvider: provider,
    fetch: trackedFetch,
  });
  const firstClient = new Client({ name: "vendo-mcp-e2e", version: "1.0.0" });
  try {
    await firstClient.connect(firstTransport);
    throw new Error("MCP SDK connected without the required OAuth challenge");
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
  }
  const authorizationUrl = provider.authorizationUrl;
  if (!authorizationUrl) throw new Error("SDK did not request an OAuth redirect");
  let authorization = await fetch(authorizationUrl, { redirect: "manual" });
  if (authorization.status === 200 && authorization.headers.get("content-type")?.includes("text/html")) {
    authorization = await submitPrebuiltConsent(authorization);
  }
  if (authorization.status !== 302) {
    throw new Error(`Authorization did not redirect (${authorization.status})`);
  }
  const location = authorization.headers.get("location");
  if (!location) throw new Error("Authorization did not return a redirect location");
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error("Authorization redirect omitted the code");
  await firstTransport.finishAuth(code);
  await firstTransport.close();

  const transport = new StreamableHTTPClientTransport(new URL(stack.endpoint), {
    authProvider: provider,
    fetch: trackedFetch,
  });
  const client = new Client({ name: "vendo-mcp-e2e", version: "1.0.0" });
  await client.connect(transport);
  return {
    client,
    transport,
    provider,
    requests,
    async close() {
      await client.close();
    },
  };
}

async function submitPrebuiltConsent(page: Response): Promise<Response> {
  const html = await page.text();
  const action = htmlAttribute(html, "form", "action").replaceAll("&amp;", "&");
  return fetch(action, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      transaction: inputValue(html, "transaction"),
      csrf_token: inputValue(html, "csrf_token"),
      decision: "approve",
    }),
  });
}

function inputValue(html: string, name: string): string {
  const match = html.match(new RegExp(`<input[^>]+name="${name}"[^>]+value="([^"]+)"`, "i"));
  if (!match?.[1]) throw new Error(`Consent page omitted ${name}`);
  return match[1];
}

function htmlAttribute(html: string, element: string, attribute: string): string {
  const match = html.match(new RegExp(`<${element}[^>]+${attribute}="([^"]+)"`, "i"));
  if (!match?.[1]) throw new Error(`Consent page omitted ${element}[${attribute}]`);
  return match[1];
}

export async function registerClient(stack: EndpointStack, redirectUris = [REDIRECT_URI]) {
  const response = await fetch(`${stack.endpoint}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Manual e2e", redirect_uris: redirectUris }),
  });
  return { response, body: await response.json() as { client_id: string } };
}

export async function authorizeCode(
  stack: EndpointStack,
  clientId: string,
  values: Record<string, string> = {},
): Promise<Response> {
  const challenge = await pkceChallenge(values.verifier ?? VERIFIER);
  const url = new URL(`${stack.endpoint}/authorize`);
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: stack.endpoint,
    scope: "read write",
    state: "e2e-state",
    ...values,
  };
  delete (params as { verifier?: string }).verifier;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return fetch(url, { redirect: "manual" });
}

export async function exchangeCode(
  stack: EndpointStack,
  values: Record<string, string>,
): Promise<Response> {
  return fetch(`${stack.endpoint}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      resource: stack.endpoint,
      ...values,
    }),
  });
}

export async function issueTokens(stack: EndpointStack, clientId: string) {
  const authorization = await authorizeCode(stack, clientId);
  const location = authorization.headers.get("location");
  if (!location) throw new Error("Authorization response omitted Location");
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error("Authorization response omitted code");
  const response = await exchangeCode(stack, {
    code,
    client_id: clientId,
    code_verifier: VERIFIER,
  });
  return {
    response,
    body: await response.json() as {
      access_token: string;
      refresh_token: string;
      token_type: "Bearer";
      expires_in: number;
      scope: string;
    },
  };
}

export async function refreshToken(
  stack: EndpointStack,
  refreshTokenValue: string,
  clientId: string,
): Promise<Response> {
  return fetch(`${stack.endpoint}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshTokenValue,
      client_id: clientId,
      resource: stack.endpoint,
    }),
  });
}

export function descriptorShape(tool: Tool) {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

export function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  return content?.find((part) => part.type === "text")?.text ?? "";
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}
