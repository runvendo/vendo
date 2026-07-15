import type {
  AuditEvent,
  Guard,
  Principal,
  RecordStore,
  StoreAdapter,
  VendoRecord,
  VendoTheme,
} from "@vendoai/core";
import { z } from "zod";
import type { HostOAuthAdapter } from "./adapter.js";

const CLIENTS_COLLECTION = "vendo_mcp_clients";
const GRANTS_COLLECTION = "vendo_mcp_grants";
const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const CODE_SECONDS = 60;
const CONSENT_SECONDS = 10 * 60;
const CLAIM_ATTEMPTS = 8;

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
  familyId: z.string().optional(),
  resource: z.string(),
  scopes: z.array(z.string()),
  codeChallenge: z.string(),
  redirectUri: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().optional(),
});

const accessGrantSchema = z.object({
  kind: z.literal("access"),
  subject: z.string(),
  clientId: z.string(),
  familyId: z.string().optional(),
  resource: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string(),
  revokedAt: z.string().optional(),
});

const refreshGrantSchema = z.object({
  kind: z.literal("refresh"),
  subject: z.string(),
  clientId: z.string(),
  familyId: z.string().optional(),
  resource: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string(),
  rotatedTo: z.string().optional(),
  revokedAt: z.string().optional(),
});

const grantFamilySchema = z.object({
  kind: z.literal("family"),
  subject: z.string(),
  clientId: z.string(),
  status: z.enum(["active", "revoked"]),
  revokedAt: z.string().optional(),
});

const consentInteractionSchema = z.object({
  kind: z.literal("consent"),
  subject: z.string().min(1),
  clientId: z.string(),
  resource: z.string(),
  scopes: z.array(z.string()),
  codeChallenge: z.string(),
  redirectUri: z.string(),
  state: z.string().nullable(),
  authorizationUrl: z.string(),
  csrfHash: z.string(),
  expiresAt: z.string(),
});

type ClientData = z.infer<typeof clientDataSchema>;
type CodeGrant = z.infer<typeof codeGrantSchema>;
type AccessGrant = z.infer<typeof accessGrantSchema>;
type RefreshGrant = z.infer<typeof refreshGrantSchema>;
type GrantFamily = z.infer<typeof grantFamilySchema>;
type ConsentInteraction = z.infer<typeof consentInteractionSchema>;

interface RevokedGrant {
  subject: string;
  clientId: string;
  tokenType: "access_token" | "refresh_token";
  familyId?: string;
}

interface RevocationResult {
  response: Response;
  grant?: RevokedGrant;
}

export interface AuthenticatedGrant {
  grant: AccessGrant;
  tokenWasPresented: boolean;
}

interface OAuthServerConfig {
  oauth: HostOAuthAdapter;
  store: StoreAdapter;
  guard: Guard;
  theme?: VendoTheme;
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
  readonly #theme: VendoTheme | undefined;

  constructor(config: OAuthServerConfig) {
    if (config.oauth.authorize === undefined && config.oauth.session === undefined) {
      throw new TypeError("HostOAuthAdapter requires `session` for the prebuilt consent flow or `authorize` for a custom flow");
    }
    this.#oauth = config.oauth;
    this.#store = config.store;
    this.#guard = config.guard;
    this.#theme = config.theme;
  }

  get hasPrebuiltConsent(): boolean {
    return this.#oauth.session !== undefined;
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
    if (req.method === "POST") return this.#decideConsent(req, resource);

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
    const authorization = {
      clientId,
      resource,
      scopes,
      codeChallenge: challenge,
      redirectUri,
      state,
    };

    if (this.#oauth.session === undefined) {
      const result = await this.#oauth.authorize!(req, { clientName: client.name, scopes });
      if (result instanceof Response) return result;
      return this.#approve(result.subject, authorization);
    }

    const session = await this.#oauth.session(req, { returnTo: req.url });
    if (session instanceof Response) return session;
    if (!session.subject) return oauthJsonError("invalid_request", "Host session did not resolve a subject");

    await this.#sweepExpiredConsents();
    const transaction = `vmci_${randomBase64Url(32)}`;
    const csrfToken = `vmcsrf_${randomBase64Url(32)}`;
    const interaction: ConsentInteraction = {
      kind: "consent",
      subject: session.subject,
      ...authorization,
      authorizationUrl: req.url,
      csrfHash: await sha256Hex(csrfToken),
      expiresAt: expiresIn(CONSENT_SECONDS),
    };
    const interactionRecord = {
      id: `mcpg_${randomHex(12)}`,
      data: interaction,
      refs: { kind: "consent", token_hash: await sha256Hex(transaction) },
    };
    await this.#store.records(GRANTS_COLLECTION).put(interactionRecord);
    const consent = { action: req.url, transaction, csrfToken };

    if (this.#oauth.authorize !== undefined) {
      const custom = await this.#oauth.authorize(req, { clientName: client.name, scopes, consent });
      if (custom instanceof Response) return custom;
      await this.#store.records(GRANTS_COLLECTION).delete(interactionRecord.id);
      if (custom.subject !== session.subject) {
        return oauthJsonError("invalid_request", "Consent subject did not match the host session");
      }
      return this.#approve(session.subject, authorization);
    }

    return consentPage(client.name, scopes, consent, this.#theme);
  }

  async #decideConsent(req: Request, resource: string): Promise<Response> {
    if (this.#oauth.session === undefined) {
      return oauthJsonError("invalid_request", "The prebuilt consent flow is not configured");
    }
    if (!contentType(req).startsWith("application/x-www-form-urlencoded")) {
      return oauthJsonError("invalid_request", "Expected application/x-www-form-urlencoded");
    }
    const sessionRequest = req.clone();
    const form = new URLSearchParams(await req.text());
    const transaction = form.get("transaction");
    const csrfToken = form.get("csrf_token");
    const decision = form.get("decision");
    if (!transaction || !csrfToken || (decision !== "approve" && decision !== "deny")) {
      return oauthJsonError("invalid_request", "transaction, csrf_token, and decision are required");
    }

    const transactionHash = await sha256Hex(transaction);
    const store = this.#store.records(GRANTS_COLLECTION);
    const record = await findOne(store, { kind: "consent", token_hash: transactionHash });
    const parsed = consentInteractionSchema.safeParse(record?.data);
    if (!record || !parsed.success || expired(parsed.data.expiresAt)) {
      if (record) await store.delete(record.id);
      return oauthJsonError("invalid_request", "Consent interaction is invalid, expired, or already used");
    }
    const interaction = parsed.data;
    if (!sameCanonicalUri(interaction.resource, resource)) {
      return oauthJsonError("invalid_request", "Consent interaction belongs to a different MCP resource");
    }
    if (await sha256Hex(csrfToken) !== interaction.csrfHash) {
      return oauthJsonError("invalid_request", "CSRF token is invalid");
    }

    const session = await this.#oauth.session!(sessionRequest, { returnTo: interaction.authorizationUrl });
    if (session instanceof Response) return session;
    if (session.subject !== interaction.subject) {
      return oauthJsonError("invalid_request", "Host session changed during consent");
    }

    // Consume atomically before redirect/code minting. A double-click, replay,
    // or request routed to another door process can produce at most one result.
    if (!store.claim) {
      return oauthJsonError("server_error", "The configured store does not support atomic consent claims");
    }
    if (!(await store.claim(record))) {
      return oauthJsonError("invalid_request", "Consent interaction is invalid, expired, or already used");
    }
    if (decision === "deny") {
      return oauthRedirect(interaction.redirectUri, {
        error: "access_denied",
        error_description: "The resource owner denied the request",
        state: interaction.state,
      });
    }
    return this.#approve(interaction.subject, interaction);
  }

  async #approve(
    subject: string,
    authorization: Pick<ConsentInteraction, "clientId" | "resource" | "scopes" | "codeChallenge" | "redirectUri" | "state">,
  ): Promise<Response> {
    const code = `vmcd_${randomBase64Url(32)}`;
    const tokenHash = await sha256Hex(code);
    const familyId = `mcgf_${randomHex(12)}`;
    const grant: CodeGrant = {
      kind: "code",
      subject,
      clientId: authorization.clientId,
      familyId,
      resource: authorization.resource,
      scopes: authorization.scopes,
      codeChallenge: authorization.codeChallenge,
      redirectUri: authorization.redirectUri,
      expiresAt: expiresIn(CODE_SECONDS),
    };
    const family: GrantFamily = {
      kind: "family",
      subject,
      clientId: authorization.clientId,
      status: "active",
    };
    const store = this.#store.records(GRANTS_COLLECTION);
    await Promise.all([
      store.put({
        id: familyId,
        data: family,
        refs: {
          kind: "family",
          family_id: familyId,
          subject,
          client_id: authorization.clientId,
        },
      }),
      store.put({
        id: `mcpg_${randomHex(12)}`,
        data: grant,
        refs: {
          kind: "code",
          token_hash: tokenHash,
          family_id: familyId,
          subject,
          client_id: authorization.clientId,
        },
      }),
    ]);
    return oauthRedirect(authorization.redirectUri, { code, state: authorization.state });
  }

  async #sweepExpiredConsents(): Promise<void> {
    const store = this.#store.records(GRANTS_COLLECTION);
    const records = await listAll(store, { kind: "consent" });
    await Promise.all(records.map(async (record) => {
      const parsed = consentInteractionSchema.safeParse(record.data);
      if (!parsed.success || expired(parsed.data.expiresAt)) await store.delete(record.id);
    }));
  }

  async token(req: Request): Promise<Response> {
    if (!contentType(req).startsWith("application/x-www-form-urlencoded")) {
      return oauthJsonError("invalid_request", "Expected application/x-www-form-urlencoded");
    }
    const form = new URLSearchParams(await req.text());
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      const code = form.get("code");
      if (!code) return oauthJsonError("invalid_request", "code is required");
      return this.#exchangeCode(form);
    }
    if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token");
      if (!refreshToken) return oauthJsonError("invalid_request", "refresh_token is required");
      return this.#rotateRefresh(form);
    }
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
    if (
      !parsed.success
      || parsed.data.revokedAt !== undefined
      || expired(parsed.data.expiresAt)
      || !(await this.#isFamilyActive(parsed.data.familyId))
    ) return null;
    return { grant: parsed.data, tokenWasPresented: true };
  }

  async revoke(req: Request): Promise<RevocationResult> {
    if (!contentType(req).startsWith("application/x-www-form-urlencoded")) {
      return { response: oauthJsonError("invalid_request", "Expected application/x-www-form-urlencoded") };
    }
    const form = new URLSearchParams(await req.text());
    const token = form.get("token");
    const clientId = form.get("client_id");
    if (!token || !clientId) {
      return { response: oauthJsonError("invalid_request", "token and client_id are required") };
    }
    try {
      await this.#resolveClient(clientId);
    } catch (error) {
      return { response: oauthJsonError("invalid_client", errorMessage(error)) };
    }

    const store = this.#store.records(GRANTS_COLLECTION);
    if (!store.claim) {
      return { response: oauthJsonError("server_error", "The configured store does not support atomic token claims") };
    }
    const tokenHash = await sha256Hex(token);
    const hint = form.get("token_type_hint");
    const kinds = hint === "refresh_token"
      ? ["refresh", "access"] as const
      : ["access", "refresh"] as const;
    for (const kind of kinds) {
      const record = await findOne(store, { kind, token_hash: tokenHash });
      if (!record) continue;
      if (kind === "access") {
        const parsed = accessGrantSchema.safeParse(record.data);
        if (!parsed.success) return { response: revocationSuccess() };
        if (parsed.data.clientId !== clientId) {
          return { response: oauthJsonError("invalid_client", "Token was not issued to this client") };
        }
        const changed = await this.#revokeTokenRecord(record, accessGrantSchema);
        if (changed) await this.#audit({ kind: "user", subject: parsed.data.subject }, clientId, "revoke");
        return {
          response: revocationSuccess(),
          grant: {
            subject: parsed.data.subject,
            clientId,
            tokenType: "access_token",
            ...(parsed.data.familyId === undefined ? {} : { familyId: parsed.data.familyId }),
          },
        };
      }

      const parsed = refreshGrantSchema.safeParse(record.data);
      if (!parsed.success) return { response: revocationSuccess() };
      if (parsed.data.clientId !== clientId) {
        return { response: oauthJsonError("invalid_client", "Token was not issued to this client") };
      }
      const changed = parsed.data.familyId === undefined
        ? await this.#revokeSubjectClientGrants(parsed.data.subject, clientId)
        : await this.#revokeFamily(parsed.data.familyId);
      if (changed) await this.#audit({ kind: "user", subject: parsed.data.subject }, clientId, "revoke");
      return {
        response: revocationSuccess(),
        grant: {
          subject: parsed.data.subject,
          clientId,
          tokenType: "refresh_token",
          ...(parsed.data.familyId === undefined ? {} : { familyId: parsed.data.familyId }),
        },
      };
    }
    return { response: revocationSuccess() };
  }

  /** Host-side per-client disconnect. The caller owns host authorization for
   * this API; the door atomically revokes every existing grant family. */
  async revokeClient(subject: string, clientId: string): Promise<boolean> {
    return this.#revokeSubjectClientGrants(subject, clientId);
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
    if (!record || !parsed.success || parsed.data.revokedAt !== undefined || expired(parsed.data.expiresAt)) {
      return oauthJsonError("invalid_grant", "Authorization code is invalid or expired");
    }
    // The code is single-use the moment it is PRESENTED, not only when it is
    // redeemed: a stolen code must not survive a failed PKCE/binding attempt
    // and stay guessable-against for the rest of its TTL.
    if (!store.claim) {
      return oauthJsonError("server_error", "The configured store does not support atomic token claims");
    }
    if (!(await store.claim(record))) {
      return oauthJsonError("invalid_grant", "Authorization code is invalid or expired");
    }

    const grant = parsed.data;
    if (grant.clientId !== clientId || grant.redirectUri !== redirectUri) {
      return oauthJsonError("invalid_grant", "Authorization code binding mismatch");
    }
    if (await sha256Base64Url(verifier) !== grant.codeChallenge) {
      return oauthJsonError("invalid_grant", "PKCE verification failed");
    }
    if (!(await this.#isFamilyActive(grant.familyId))) {
      return oauthJsonError("invalid_grant", "Authorization grant is revoked");
    }
    const requestedResource = form.get("resource");
    if (requestedResource !== null && !sameCanonicalUri(requestedResource, grant.resource)) {
      return oauthJsonError("invalid_target", "resource does not match the authorization code");
    }

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
    if (
      !record
      || !parsed.success
      || parsed.data.revokedAt !== undefined
      || expired(parsed.data.expiresAt)
      || parsed.data.clientId !== clientId
    ) {
      return oauthJsonError("invalid_grant", "Refresh token is invalid or expired");
    }
    const grant = parsed.data;
    if (grant.rotatedTo !== undefined) {
      await this.#revokeGrant(grant);
      await this.#audit({ kind: "user", subject: grant.subject }, grant.clientId, "revoke");
      return oauthJsonError("invalid_grant", "Refresh token reuse detected");
    }
    if (!(await this.#isFamilyActive(grant.familyId))) {
      return oauthJsonError("invalid_grant", "Refresh token is invalid or expired");
    }
    // 10-mcp §3: principal() is the kill switch. A refresh 30 days later must
    // not mint a fresh token window for a subject the host has since revoked.
    if ((await this.#oauth.principal(grant.subject)) === null) {
      await this.#revokeSubjectClientGrants(grant.subject, grant.clientId);
      await this.#audit({ kind: "user", subject: grant.subject }, grant.clientId, "revoke");
      return oauthJsonError("invalid_grant", "Subject is no longer authorized");
    }
    const requestedResource = form.get("resource");
    if (requestedResource !== null && !sameCanonicalUri(requestedResource, grant.resource)) {
      return oauthJsonError("invalid_target", "resource does not match the refresh token");
    }

    if (!store.claim) {
      return oauthJsonError("server_error", "The configured store does not support atomic token claims");
    }
    // Persist candidate grants BEFORE claiming the parent. If another instance
    // loses the claim, reuse revocation can see and remove every candidate in
    // the successor chain. Candidate secrets are not exposed unless their
    // parent claim succeeds.
    const tokens = await this.#issueTokens(grant);
    const claimed = await store.claim(record, {
      data: { ...grant, rotatedTo: tokens.refreshGrantId },
      ...(record.refs === undefined ? {} : { refs: record.refs }),
    });
    if (!claimed) {
      await this.#revokeGrant(grant);
      await this.#audit({ kind: "user", subject: grant.subject }, grant.clientId, "revoke");
      return oauthJsonError("invalid_grant", "Refresh token reuse detected");
    }
    if (!(await this.#isFamilyActive(grant.familyId))) {
      return oauthJsonError("invalid_grant", "Refresh token is invalid or expired");
    }
    await this.#audit({ kind: "user", subject: grant.subject }, grant.clientId, "refresh");
    return json(publicTokenResponse(tokens), 200, tokenHeaders());
  }

  async #issueTokens(source: Pick<CodeGrant, "subject" | "clientId" | "familyId" | "resource" | "scopes">): Promise<{
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
      ...(source.familyId === undefined ? {} : { familyId: source.familyId }),
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
    const refs = {
      subject: source.subject,
      client_id: source.clientId,
      ...(source.familyId === undefined ? {} : { family_id: source.familyId }),
    };
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

  async #isFamilyActive(familyId: string | undefined): Promise<boolean> {
    if (familyId === undefined) return true; // compatibility for pre-family grants
    const record = await this.#store.records(GRANTS_COLLECTION).get(familyId);
    const parsed = grantFamilySchema.safeParse(record?.data);
    return parsed.success && parsed.data.status === "active";
  }

  async #revokeGrant(grant: RefreshGrant): Promise<boolean> {
    return grant.familyId === undefined
      ? this.#revokeSubjectClientGrants(grant.subject, grant.clientId)
      : this.#revokeFamily(grant.familyId);
  }

  async #revokeFamily(familyId: string): Promise<boolean> {
    const store = this.#store.records(GRANTS_COLLECTION);
    if (!store.claim) throw new Error("The configured store does not support atomic token claims");
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const record = await store.get(familyId);
      const parsed = grantFamilySchema.safeParse(record?.data);
      if (!record || !parsed.success || parsed.data.status === "revoked") return false;
      const replacement: GrantFamily = {
        ...parsed.data,
        status: "revoked",
        revokedAt: new Date().toISOString(),
      };
      if (await store.claim(record, {
        data: replacement,
        ...(record.refs === undefined ? {} : { refs: record.refs }),
      })) return true;
    }
    throw new Error("Grant family changed too many times during revocation");
  }

  async #revokeSubjectClientGrants(subject: string, clientId: string): Promise<boolean> {
    const store = this.#store.records(GRANTS_COLLECTION);
    if (!store.claim) throw new Error("The configured store does not support atomic token claims");
    let changed = false;
    const families = await listAll(store, { kind: "family", subject, client_id: clientId });
    for (const family of families) {
      changed = await this.#revokeFamily(family.id) || changed;
    }

    // Outstanding grants minted before family anchors shipped remain valid
    // across a rolling deployment. Revoke those with the same guarded UPDATE
    // pattern instead of list-then-delete.
    const legacy = await listAll(store, { subject, client_id: clientId });
    for (const record of legacy) {
      const access = accessGrantSchema.safeParse(record.data);
      if (access.success && access.data.familyId === undefined) {
        changed = await this.#revokeTokenRecord(record, accessGrantSchema) || changed;
        continue;
      }
      const refresh = refreshGrantSchema.safeParse(record.data);
      if (refresh.success && refresh.data.familyId === undefined) {
        changed = await this.#revokeTokenRecord(record, refreshGrantSchema) || changed;
      }
    }
    // Pre-family authorization codes did not carry subject/client refs. Their
    // one-minute window still overlaps rolling deploys, so scan the bounded
    // code set, filter by parsed binding, and guard-update matches as revoked.
    const legacyCodes = await listAll(store, { kind: "code" });
    for (const record of legacyCodes) {
      const code = codeGrantSchema.safeParse(record.data);
      if (
        code.success
        && code.data.familyId === undefined
        && code.data.subject === subject
        && code.data.clientId === clientId
      ) {
        changed = await this.#revokeTokenRecord(record, codeGrantSchema) || changed;
      }
    }
    return changed;
  }

  async #revokeTokenRecord<T extends CodeGrant | AccessGrant | RefreshGrant>(
    initial: VendoRecord,
    schema: z.ZodType<T>,
  ): Promise<boolean> {
    const store = this.#store.records(GRANTS_COLLECTION);
    if (!store.claim) throw new Error("The configured store does not support atomic token claims");
    let record: VendoRecord | null = initial;
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const parsed = schema.safeParse(record?.data);
      if (!record || !parsed.success || parsed.data.revokedAt !== undefined) return false;
      const replacement = { ...parsed.data, revokedAt: new Date().toISOString() };
      if (await store.claim(record, {
        data: replacement,
        ...(record.refs === undefined ? {} : { refs: record.refs }),
      })) return true;
      record = await store.get(initial.id);
    }
    throw new Error("Token grant changed too many times during revocation");
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

const CIMD_MAX_BYTES = 64 * 1024;

/** True for any IPv4/IPv6 literal that must never be fetched server-side —
 * loopback, private (RFC 1918), link-local (incl. the cloud-metadata
 * 169.254.169.254), CGNAT, ULA, and unspecified. */
function isPrivateAddress(host: string): boolean {
  const address = host.startsWith("[") ? host.slice(1, -1) : host;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64/10
    );
  }
  const v6 = address.toLowerCase();
  if (!v6.includes(":")) return false;
  // Map ::ffff:a.b.c.d back to its v4 rules, then cover ::1, fc00::/7, fe80::/10, ::.
  const mapped = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]!);
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") ||
    v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb");
}

/** Syntactic SSRF floor for the attacker-supplied CIMD URL: https-only, no
 * credentials, no redirects, no IP-literal or loopback/link-local-style hosts,
 * 5s timeout, 64 KB cap. This runs everywhere. */
function assertPublicCimdHost(url: URL): void {
  const host = url.hostname.toLowerCase();
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":");
  if (
    isIpLiteral || host === "localhost" || host.endsWith(".localhost") ||
    host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".") ||
    isPrivateAddress(host)
  ) {
    throw new Error("Client ID Metadata Document host is not a public hostname");
  }
}

/** Best-effort DNS-rebinding defense: when a DNS resolver is available (Node),
 * resolve the CIMD hostname and reject if ANY answer is a private address —
 * this is what closes the wildcard-DNS bypass (`169-254-169-254.sslip.io`).
 * On runtimes without node:dns (edge/Bun-without-node-compat) it is a no-op and
 * the syntactic floor above plus the host's network egress policy stand. */
async function assertPublicCimdResolution(host: string): Promise<void> {
  let lookup: ((h: string, opts: { all: true }) => Promise<Array<{ address: string }>>) | undefined;
  try {
    const dns = await import("node:dns/promises");
    lookup = dns.lookup as unknown as typeof lookup;
  } catch {
    return; // No resolver here — the syntactic floor already ran.
  }
  if (!lookup) return;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error("Client ID Metadata Document host did not resolve");
  }
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("Client ID Metadata Document host resolves to a private address");
  }
}

async function readCappedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Client ID Metadata Document had no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CIMD_MAX_BYTES) {
      await reader.cancel();
      throw new Error("Client ID Metadata Document is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function resolveCimdClient(clientId: string): Promise<ResolvedClient> {
  const url = new URL(clientId);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Client ID Metadata Document client_id must be an HTTPS URL");
  }
  assertPublicCimdHost(url);
  await assertPublicCimdResolution(url.hostname);
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
    const parsed = cimdClientSchema.safeParse(await readCappedJson(response));
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

function consentPage(
  clientName: string,
  scopes: string[],
  flow: { action: string; transaction: string; csrfToken: string },
  theme?: VendoTheme,
): Response {
  const safeClientName = escapeHtml(clientName);
  const themeStyle = theme === undefined ? "" : ` style="${escapeHtml(vendoThemeStyle(theme))}"`;
  const scopeList = scopes.length === 0
    ? ""
    : `<div class="scope"><span>Requested access</span><strong>${escapeHtml(scopes.join(" · "))}</strong></div>`;
  const html = `<!doctype html>
<html lang="en"${themeStyle}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize MCP access</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: var(--vendo-font-family, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--vendo-font-size, 15px);
      color: var(--vendo-color-text, #17181d);
      background: var(--vendo-color-background, #f3ede2);
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: var(--vendo-space-large, 28px);
      background:
        radial-gradient(circle at 20% 0%, color-mix(in srgb, var(--vendo-color-accent, #3157d5) 12%, transparent), transparent 38rem),
        var(--vendo-color-background, #f3ede2);
    }
    main {
      width: min(100%, 31rem);
      padding: var(--vendo-space-large, 30px);
      border: 1px solid var(--vendo-color-border, rgba(23, 24, 29, .12));
      border-radius: var(--vendo-radius-medium, 16px);
      background: var(--vendo-color-surface, #fffdf9);
      box-shadow: 0 22px 70px color-mix(in srgb, var(--vendo-color-text, #17181d) 12%, transparent);
    }
    .mark {
      width: 2.4rem;
      height: 2.4rem;
      display: grid;
      place-items: center;
      border-radius: var(--vendo-radius-small, 10px);
      color: var(--vendo-color-accent-text, #fff);
      background: var(--vendo-color-accent, #3157d5);
      font-weight: 750;
      letter-spacing: -.04em;
    }
    h1 {
      margin: var(--vendo-space-large, 24px) 0 var(--vendo-space-small, 10px);
      font-family: var(--vendo-heading-family, var(--vendo-font-family, inherit));
      font-size: clamp(1.45rem, 4vw, 1.8rem);
      line-height: 1.18;
      letter-spacing: -.025em;
    }
    p { margin: 0; color: var(--vendo-color-muted, #686a73); line-height: 1.55; }
    .scope {
      display: flex;
      justify-content: space-between;
      gap: var(--vendo-space-medium, 14px);
      margin-top: var(--vendo-space-large, 24px);
      padding: var(--vendo-space-medium, 14px);
      border: 1px solid var(--vendo-color-border, rgba(23, 24, 29, .12));
      border-radius: var(--vendo-radius-small, 10px);
      background: color-mix(in srgb, var(--vendo-color-surface, #fffdf9) 78%, var(--vendo-color-background, #f3ede2));
      font-size: .86rem;
    }
    .scope span { color: var(--vendo-color-muted, #686a73); }
    .scope strong { overflow-wrap: anywhere; text-align: right; }
    form { display: flex; gap: var(--vendo-space-small, 10px); margin-top: var(--vendo-space-large, 26px); }
    button {
      min-height: 2.7rem;
      flex: 1;
      border: 1px solid var(--vendo-color-border, rgba(23, 24, 29, .14));
      border-radius: var(--vendo-radius-small, 10px);
      padding: .7rem 1rem;
      font: 650 1rem/1 var(--vendo-font-family, inherit);
      color: var(--vendo-color-text, #17181d);
      background: var(--vendo-color-surface, #fffdf9);
      cursor: pointer;
    }
    button:hover { border-color: var(--vendo-color-accent, #3157d5); }
    button:focus-visible { outline: 3px solid color-mix(in srgb, var(--vendo-color-accent, #3157d5) 35%, transparent); outline-offset: 2px; }
    button[value="approve"] {
      border-color: transparent;
      color: var(--vendo-color-accent-text, #fff);
      background: var(--vendo-color-accent, #3157d5);
    }
    .fine { margin-top: var(--vendo-space-medium, 14px); font-size: .78rem; text-align: center; }
    @media (max-width: 30rem) {
      main { padding: var(--vendo-space-large, 24px) var(--vendo-space-medium, 18px); }
      form { flex-direction: column-reverse; }
    }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">V</div>
    <h1>Allow ${safeClientName} to access this product?</h1>
    <p>This client will be able to use the tools available to your account. Vendo's policy, approval, and audit controls still apply.</p>
    ${scopeList}
    <form method="post" action="${escapeHtml(flow.action)}">
      <input type="hidden" name="transaction" value="${escapeHtml(flow.transaction)}">
      <input type="hidden" name="csrf_token" value="${escapeHtml(flow.csrfToken)}">
      <button type="submit" name="decision" value="deny">Deny</button>
      <button type="submit" name="decision" value="approve">Allow</button>
    </form>
    <p class="fine">You can revoke access from this product at any time.</p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Mirrors `@vendoai/ui`'s public theme-token mapping without importing that
 * sibling package: the MCP block's contract permits a core dependency only. */
function vendoThemeStyle(theme: VendoTheme): string {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.colors)) {
    variables[`--vendo-color-${kebab(key)}`] = value;
  }
  variables["--vendo-font-family"] = theme.typography.fontFamily;
  if (theme.typography.headingFamily !== undefined) {
    variables["--vendo-heading-family"] = theme.typography.headingFamily;
  }
  variables["--vendo-font-size"] = theme.typography.baseSize;
  for (const [key, value] of Object.entries(theme.radius)) {
    variables[`--vendo-radius-${kebab(key)}`] = value;
  }
  variables["--vendo-density"] = theme.density;
  variables["--vendo-motion"] = theme.motion;
  return Object.entries(variables).map(([name, value]) => `${name}:${value}`).join(";");
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
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

function revocationSuccess(): Response {
  return new Response(null, { status: 200, headers: tokenHeaders() });
}
