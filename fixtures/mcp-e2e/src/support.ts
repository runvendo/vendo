import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { REDIRECT_URI } from "@vendoai-fixtures/test-kit/mcp-client";

// The authenticated SDK connection is shared with the browser leg, so it lives in
// test-kit; re-exported here so this suite's specs keep one support import.
export { connectWithSdk } from "@vendoai-fixtures/test-kit/mcp-client";

interface EndpointStack {
  endpoint: string;
}

export const VERIFIER = "mcp-e2e-verifier-with-enough-entropy-1234567890-abcdefghijklmnop";

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
