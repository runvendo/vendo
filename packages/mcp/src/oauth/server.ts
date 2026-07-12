import type {
  AuditEvent,
  Guard,
  Principal,
  RecordStore,
  StoreAdapter,
} from "@vendoai/core";
import { z } from "zod";
import type { HostOAuthAdapter } from "./adapter.js";

const CLIENTS_COLLECTION = "vendo_mcp_clients";
const GRANTS_COLLECTION = "vendo_mcp_grants";
const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const CODE_SECONDS = 60;

const clientDataSchema = z.object({
  client_name: z.string(),
  redirect_uris: z.array(z.string()).min(1),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])),
  token_endpoint_auth_method: z.literal("none"),
  scope: z.string().optional(),
});

const registrationRequestSchema = z.object({
  redirect_uris: z.array(z.string()).min(1),
  client_name: z.string().min(1).optional(),
  scope: z.string().optional(),
});

const cimdClientSchema = z.object({
  client_id: z.string(),
  client_name: z.string().optional(),
  redirect_uris: z.array(z.string()).min(1),
});

const codeGrantSchema = z.object({
  kind: z.literal("code"),
  subject: z.string(),
  clientId: z.string(),
  resource: z.string(),
  scopes: z.array(z.string()),
  codeChallenge: z.string(),
  redirectUri: z.string(),
  expiresAt: z.string(),
});

const accessGrantSchema = z.object({
  kind: z.literal("access"),
  subject: z.string(),
  clientId: z.string(),
  resource: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string(),
});

const refreshGrantSchema = z.object({
  kind: z.literal("refresh"),
  subject: z.string(),
  clientId: z.string(),
  resource: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string(),
  rotatedTo: z.string().optional(),
});

type ClientData = z.infer<typeof clientDataSchema>;
type CodeGrant = z.infer<typeof codeGrantSchema>;
type AccessGrant = z.infer<typeof accessGrantSchema>;
type RefreshGrant = z.infer<typeof refreshGrantSchema>;

export interface AuthenticatedGrant {
  grant: AccessGrant;
  tokenWasPresented: boolean;
}

interface OAuthServerConfig {
  oauth: HostOAuthAdapter;
  store: StoreAdapter;
  guard: Guard;
}

interface ResolvedClient {
  id: string;
  name: string;
  redirectUris: string[];
}

export class OAuthServer {
  readonly #oauth: HostOAuthAdapter;
  readonly #store: StoreAdapter;
  readonly #guard: Guard;

  constructor(config: OAuthServerConfig) {
    this.#oauth = config.oauth;
    this.#store = config.store;
    this.#guard = config.guard;
  }

  async register(req: Request): Promise<Response> {
    if (!contentType(req).startsWith("application/json")) {
      return oauthJsonError("invalid_client_metadata", "Expected application/json");
    }

    const body = await readJson(req);
    const parsed = registrationRequestSchema.safeParse(body);
    if (!parsed.success || !parsed.data.redirect_uris.every(validRedirectUri)) {
      return oauthJsonError("invalid_redirect_uri", "redirect_uris must contain valid absolute redirect URIs");
    }

    const clientId = `mcpc_${randomHex(12)}`;
    const data: ClientData = {
      client_name: parsed.data.client_name ?? "MCP client",
      redirect_uris: parsed.data.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      ...(parsed.data.scope === undefined ? {} : { scope: parsed.data.scope }),
    };
    await this.#store.records(CLIENTS_COLLECTION).put({ id: clientId, data, refs: {} });
    await this.#audit({ kind: "user", subject: clientId, ephemeral: true }, clientId, "register");
    return json({ client_id: clientId, ...data }, 201);
  }

  async authorize(req: Request, resource: string): Promise<Response> {
    const url = new URL(req.url);
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    if (!clientId || !redirectUri) {
      return oauthJsonError("invalid_request", "client_id and redirect_uri are required");
    }

    let client: ResolvedClient;
    try {
      client = await this.#resolveClient(clientId);
    } catch (error) {
      return oauthJsonError("invalid_client", errorMessage(error));
    }
    if (!client.redirectUris.includes(redirectUri)) {
      return oauthJsonError("invalid_request", "redirect_uri is not registered");
    }

    const redirectError = (code: string, description: string) =>
      oauthRedirect(redirectUri, { error: code, error_description: description, state });
    if (url.searchParams.get("response_type") !== "code") {
      return redirectError("unsupported_response_type", "response_type must be code");
    }
    const challenge = url.searchParams.get("code_challenge");
    if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || url.searchParams.get("code_challenge_method") !== "S256") {
      return redirectError("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    const requestedResource = url.searchParams.get("resource");
    if (requestedResource !== null && !sameCanonicalUri(requestedResource, resource)) {
      return redirectError("invalid_target", "resource does not identify this MCP server");
    }

    const scopes = splitScopes(url.searchParams.get("scope"));
    const result = await this.#oauth.authorize(req, { clientName: client.name, scopes });
    if (result instanceof Response) return result;

    const code = `vmcd_${randomBase64Url(32)}`;
    const tokenHash = await sha256Hex(code);
    const grant: CodeGrant = {
      kind: "code",
      subject: result.subject,
      clientId,
      resource,
      scopes,
      codeChallenge: challenge,
      redirectUri,
      expiresAt: expiresIn(CODE_SECONDS),
    };
    await this.#store.records(GRANTS_COLLECTION).put({
      id: `mcpg_${randomHex(12)}`,
      data: grant,
      refs: { kind: "code", token_hash: tokenHash },
    });
    return oauthRedirect(redirectUri, { code, state });
  }

  async token(req: Request): Promise<Response> {
    if (!contentType(req).startsWith("application/x-www-form-urlencoded")) {
      return oauthJsonError("invalid_request", "Expected application/x-www-form-urlencoded");
    }
    const form = new URLSearchParams(await req.text());
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") return this.#exchangeCode(form);
    if (grantType === "refresh_token") return this.#rotateRefresh(form);
    return oauthJsonError("unsupported_grant_type", "Unsupported grant_type");
  }

  async authenticate(req: Request): Promise<AuthenticatedGrant | null> {
    const header = req.headers.get("authorization");
    const match = header?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match?.[1]) return null;
    const record = await findOne(this.#store.records(GRANTS_COLLECTION), {
      kind: "access",
      token_hash: await sha256Hex(match[1]),
    });
    if (!record) return null;
    const parsed = accessGrantSchema.safeParse(record.data);
    if (!parsed.success || expired(parsed.data.expiresAt)) return null;
    return { grant: parsed.data, tokenWasPresented: true };
  }

  async principal(subject: string): Promise<Principal | null> {
    return this.#oauth.principal(subject);
  }

  async auditRevoke(subject: string, clientId: string): Promise<void> {
    await this.#audit({ kind: "user", subject }, clientId, "revoke");
  }

  async #exchangeCode(form: URLSearchParams): Promise<Response> {
    const code = form.get("code");
    const clientId = form.get("client_id");
    const redirectUri = form.get("redirect_uri");
    const verifier = form.get("code_verifier");
    if (!code || !clientId || !redirectUri || !verifier) {
      return oauthJsonError("invalid_request", "code, client_id, redirect_uri, and code_verifier are required");
    }
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
      return oauthJsonError("invalid_grant", "PKCE verifier is invalid");
    }

    const store = this.#store.records(GRANTS_COLLECTION);
    const record = await findOne(store, { kind: "code", token_hash: await sha256Hex(code) });
    const parsed = codeGrantSchema.safeParse(record?.data);
    if (!record || !parsed.success || expired(parsed.data.expiresAt)) {
      return oauthJsonError("invalid_grant", "Authorization code is invalid or expired");
    }
    const grant = parsed.data;
    if (grant.clientId !== clientId || grant.redirectUri !== redirectUri) {
      return oauthJsonError("invalid_grant", "Authorization code binding mismatch");
    }
    if (await sha256Base64Url(verifier) !== grant.codeChallenge) {
      return oauthJsonError("invalid_grant", "PKCE verification failed");
    }
    const requestedResource = form.get("resource");
    if (requestedResource !== null && !sameCanonicalUri(requestedResource, grant.resource)) {
      return oauthJsonError("invalid_target", "resource does not match the authorization code");
    }

    await store.delete(record.id);
    const tokens = await this.#issueTokens(grant);
    await this.#audit({ kind: "user", subject: grant.subject }, grant.clientId, "issue");
    return json(publicTokenResponse(tokens), 200, tokenHeaders());
  }

  async #rotateRefresh(form: URLSearchParams): Promise<Response> {
    const refreshToken = form.get("refresh_token");
    const clientId = form.get("client_id");
    if (!refreshToken || !clientId) {
      return oauthJsonError("invalid_request", "refresh_token and client_id are required");
    }

    const store = this.#store.records(GRANTS_COLLECTION);
    const record = await findOne(store, { kind: "refresh", token_hash: await sha256Hex(refreshToken) });
    const parsed = refreshGrantSchema.safeParse(record?.data);
    if (!record || !parsed.success || expired(parsed.data.expiresAt) || parsed.data.clientId !== clientId) {
      return oauthJsonError("invalid_grant", "Refresh token is invalid or expired");
    }
    const grant = parsed.data;
    if (grant.rotatedTo !== undefined) {
      await this.#revokeSubjectClient(grant.subject, grant.clientId);
      await this.#audit({ kind: "user", subject: grant.subject }, grant.clientId, "revoke");
      return oauthJsonError("invalid_grant", "Refresh token reuse detected");
    }
    const requestedResource = form.get("resource");
    if (requestedResource !== null && !sameCanonicalUri(requestedResource, grant.resource)) {
      return oauthJsonError("invalid_target", "resource does not match the refresh token");
    }

    const tokens = await this.#issueTokens(grant);
    await store.put({
      id: record.id,
      data: { ...grant, rotatedTo: tokens.refreshGrantId },
      refs: record.refs,
    });
    await this.#audit({ kind: "user", subject: grant.subject }, grant.clientId, "refresh");
    return json(publicTokenResponse(tokens), 200, tokenHeaders());
  }

  async #issueTokens(source: Pick<CodeGrant, "subject" | "clientId" | "resource" | "scopes">): Promise<{
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    refresh_token: string;
    scope: string;
    refreshGrantId: string;
  }> {
    const accessToken = `vmat_${randomBase64Url(32)}`;
    const refreshToken = `vmrt_${randomBase64Url(32)}`;
    const binding = {
      subject: source.subject,
      clientId: source.clientId,
      resource: source.resource,
      scopes: source.scopes,
    };
    const accessGrant: AccessGrant = {
      kind: "access",
      ...binding,
      expiresAt: expiresIn(ACCESS_TOKEN_SECONDS),
    };
    const refreshGrant: RefreshGrant = {
      kind: "refresh",
      ...binding,
      expiresAt: expiresIn(REFRESH_TOKEN_SECONDS),
    };
    const accessGrantId = `mcpg_${randomHex(12)}`;
    const refreshGrantId = `mcpg_${randomHex(12)}`;
    const refs = { subject: source.subject, client_id: source.clientId };
    await Promise.all([
      this.#store.records(GRANTS_COLLECTION).put({
        id: accessGrantId,
        data: accessGrant,
        refs: { kind: "access", token_hash: await sha256Hex(accessToken), ...refs },
      }),
      this.#store.records(GRANTS_COLLECTION).put({
        id: refreshGrantId,
        data: refreshGrant,
        refs: { kind: "refresh", token_hash: await sha256Hex(refreshToken), ...refs },
      }),
    ]);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refreshToken,
      scope: source.scopes.join(" "),
      refreshGrantId,
    };
  }

  async #resolveClient(clientId: string): Promise<ResolvedClient> {
    if (clientId.startsWith("https://")) return resolveCimdClient(clientId);
    const record = await this.#store.records(CLIENTS_COLLECTION).get(clientId);
    const parsed = clientDataSchema.safeParse(record?.data);
    if (!parsed.success) throw new Error("Unknown client_id");
    return { id: clientId, name: parsed.data.client_name, redirectUris: parsed.data.redirect_uris };
  }

  async #revokeSubjectClient(subject: string, clientId: string): Promise<void> {
    const store = this.#store.records(GRANTS_COLLECTION);
    const records = await listAll(store, { subject, client_id: clientId });
    await Promise.all(records.map((record) => store.delete(record.id)));
  }

  async #audit(principal: Principal, clientId: string, event: "issue" | "refresh" | "register" | "revoke"): Promise<void> {
    const audit: AuditEvent = {
      id: `aud_${randomHex(12)}`,
      at: new Date().toISOString(),
      kind: "door-auth",
      principal,
      venue: "mcp",
      presence: "present",
      detail: { clientId, event },
    };
    await this.#guard.report(audit);
  }
}

async function resolveCimdClient(clientId: string): Promise<ResolvedClient> {
  const url = new URL(clientId);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Client ID Metadata Document client_id must be an HTTPS URL");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(clientId, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok || !contentType(response).includes("application/json")) {
      throw new Error("Client ID Metadata Document did not return JSON");
    }
    const parsed = cimdClientSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.client_id !== clientId || !parsed.data.redirect_uris.every(validRedirectUri)) {
      throw new Error("Invalid Client ID Metadata Document");
    }
    return {
      id: clientId,
      name: parsed.data.client_name ?? clientId,
      redirectUris: parsed.data.redirect_uris,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function contentType(value: Request | Response): string {
  return value.headers.get("content-type")?.toLowerCase() ?? "";
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function splitScopes(value: string | null): string[] {
  return [...new Set((value ?? "").split(/\s+/).filter(Boolean))];
}

function expiresIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

function expired(value: string): boolean {
  const time = Date.parse(value);
  return !Number.isFinite(time) || time <= Date.now();
}

function randomHex(byteLength: number): string {
  return [...crypto.getRandomValues(new Uint8Array(byteLength))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomBase64Url(byteLength: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let bits = 0;
  let accumulator = 0;
  let output = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      output += alphabet[(accumulator >>> bits) & 63];
    }
  }
  if (bits > 0) output += alphabet[(accumulator << (6 - bits)) & 63];
  return output;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let bits = 0;
  let accumulator = 0;
  let output = "";
  for (const byte of digest) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      output += alphabet[(accumulator >>> bits) & 63];
    }
  }
  if (bits > 0) output += alphabet[(accumulator << (6 - bits)) & 63];
  return output;
}

async function findOne(store: RecordStore, refs: Record<string, string>) {
  const result = await store.list({ refs, limit: 1 });
  return result.records[0];
}

async function listAll(store: RecordStore, refs: Record<string, string>) {
  const records = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ refs, ...(cursor === undefined ? {} : { cursor }) });
    records.push(...page.records);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return records;
}

function oauthRedirect(redirectUri: string, values: Record<string, string | null>): Response {
  const location = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) location.searchParams.set(key, value);
  }
  return new Response(null, { status: 302, headers: { location: location.toString() } });
}

function oauthJsonError(error: string, description: string): Response {
  return json({ error, error_description: description }, 400, { "cache-control": "no-store" });
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Client resolution failed";
}

export function canonicalUri(input: string): string {
  const url = new URL(input);
  if (url.username || url.password) throw new TypeError("Canonical URIs cannot contain credentials");
  const protocol = url.protocol.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const port = (protocol === "https:" && url.port === "443") || (protocol === "http:" && url.port === "80")
    ? ""
    : url.port;
  const host = `${hostname}${port ? `:${port}` : ""}`;
  const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${protocol}//${host}${pathname}${url.search}${url.hash}`;
}

export function sameCanonicalUri(left: string, right: string): boolean {
  try {
    return canonicalUri(left) === canonicalUri(right);
  } catch {
    return false;
  }
}

function publicTokenResponse(tokens: {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}) {
  return {
    access_token: tokens.access_token,
    token_type: tokens.token_type,
    expires_in: tokens.expires_in,
    refresh_token: tokens.refresh_token,
    scope: tokens.scope,
  };
}

function tokenHeaders(): Record<string, string> {
  return { "cache-control": "no-store", pragma: "no-cache" };
}
