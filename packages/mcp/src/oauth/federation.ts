import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { HostOAuthAdapter } from "./adapter.js";

const requestClaimsSchema = z.object({
  iss: z.string().url(),
  aud: z.string(),
  exp: z.number().int(),
  jti: z.string().min(1),
  redirect_uri: z.string().url(),
  scopes: z.array(z.string()),
  client_name: z.string().min(1),
});

export async function handleFederation(
  req: Request,
  resource: string,
  secret: string,
  oauth: HostOAuthAdapter,
): Promise<Response> {
  if (oauth.authorize === undefined && oauth.session === undefined) return invalidRequest();
  const compact = new URL(req.url).searchParams.get("request");
  if (!compact) return invalidRequest();

  let claims: z.infer<typeof requestClaimsSchema>;
  try {
    const { payload } = await jwtVerify(compact, secretKey(secret), {
      algorithms: ["HS256"],
      audience: resource,
      requiredClaims: ["iss", "aud", "exp", "jti"],
    });
    const parsed = requestClaimsSchema.safeParse(payload);
    if (!parsed.success) return invalidRequest();
    claims = parsed.data;
  } catch {
    return invalidRequest();
  }

  const now = Math.floor(Date.now() / 1_000);
  if (claims.exp <= now || claims.exp > now + 5 * 60) return invalidRequest();
  try {
    if (new URL(claims.redirect_uri).origin !== new URL(claims.iss).origin) return invalidRequest();
  } catch {
    return invalidRequest();
  }

  // Federation delegates the consent decision to the external authorization
  // server, so the host only has to answer "who is this user". A full
  // `authorize` adapter keeps its original semantics; a prebuilt-flow adapter
  // authenticates through `session` with the federate request itself as the
  // returnTo, so a host login bounce comes back and retries the handshake.
  const authorized = oauth.authorize !== undefined
    ? await oauth.authorize(req, { clientName: claims.client_name, scopes: claims.scopes })
    : await oauth.session!(req, { returnTo: req.url });
  if (authorized instanceof Response) return authorized;

  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(resource)
    .setAudience(claims.iss)
    .setSubject(authorized.subject)
    .setJti(claims.jti)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(secretKey(secret));
  const redirect = new URL(claims.redirect_uri);
  redirect.searchParams.set("assertion", assertion);
  return new Response(null, { status: 302, headers: { location: redirect.toString() } });
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function invalidRequest(): Response {
  return new Response(JSON.stringify({ error: "invalid_request" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}
