/** MCP SDK client-driving helpers for J6, ported from fixtures/mcp-e2e/src/support.ts
 * (that suite owns door-internal OAuth conformance; this one reuses its client
 * plumbing to prove the door composes around the umbrella's parts). Adapted to
 * take the door endpoint URL directly rather than the mcp-e2e Stack shape. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { expect } from "vitest";

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
      client_name: "Vendo integration MCP",
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

/** Drive the real MCP SDK through the full 401 → discovery → OAuth → connect
 * round trip against the door mounted at `endpoint`. */
export async function connectWithSdk(endpoint: string): Promise<ConnectedClient> {
  const provider = new TestOAuthProvider();
  const requests: URL[] = [];
  const trackedFetch: typeof fetch = async (input, init) => {
    requests.push(new URL(input instanceof Request ? input.url : input));
    return fetch(input, init);
  };
  const firstTransport = new StreamableHTTPClientTransport(new URL(endpoint), {
    authProvider: provider,
    fetch: trackedFetch,
  });
  const firstClient = new Client({ name: "vendo-integration-mcp", version: "1.0.0" });
  await expect(firstClient.connect(firstTransport)).rejects.toBeInstanceOf(UnauthorizedError);
  const authorizationUrl = provider.authorizationUrl;
  if (!authorizationUrl) throw new Error("SDK did not request an OAuth redirect");
  const authorization = await fetch(authorizationUrl, { redirect: "manual" });
  expect(authorization.status).toBe(302);
  const location = authorization.headers.get("location");
  if (!location) throw new Error("Authorization did not return a redirect location");
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error("Authorization redirect omitted the code");
  await firstTransport.finishAuth(code);
  await firstTransport.close();

  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    authProvider: provider,
    fetch: trackedFetch,
  });
  const client = new Client({ name: "vendo-integration-mcp", version: "1.0.0" });
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

export function descriptorShape(tool: Tool) {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

export function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  return content?.find((part) => part.type === "text")?.text ?? "";
}
