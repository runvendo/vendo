/** A REAL MCP SDK client that completes the door's OAuth dance, shared by the
 * suites that need an authenticated connection: `mcp-e2e` (node) and
 * `integration-browser` (the Vite harness behind the Playwright leg). It lived in
 * mcp-e2e/src/support.ts and integration-browser reached in with a relative path
 * that escaped its own package — invisible until dependency-guard's scan was
 * extended past packages/. A helper two suites share belongs here by definition.
 */
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Just the door's base URL — whatever a suite's own stack type carries. */
interface EndpointStack {
  endpoint: string;
}

export const REDIRECT_URI = "http://127.0.0.1/callback";

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
