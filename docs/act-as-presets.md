# actAs presets

`@vendoai/actions/presets` turns a Vendo principal and captured grant into the
host credentials used for away automations and MCP calls. Pass the resulting
`actAs` function to `createVendo`:

```ts
import { createVendo } from "@vendoai/vendo";
import { authJsPreset } from "@vendoai/actions/presets";

const actAs = authJsPreset();
export const vendo = createVendo({ model, principal, actAs });
```

Every preset keeps minted tokens in its own closure and refreshes them before
expiry. Create one preset instance during host boot and reuse it. A missing
secret, unknown user, or revoked user should return `null`; Vendo then fails the
run closed.

Keep all signing secrets server-only. The preset secret must be the same secret
the host API verifier uses, never a public or publishable key.

## Auth.js and NextAuth v5

Install Auth.js alongside the preset. It is an optional peer so hosts that do
not use Auth.js do not install it.

```sh
pnpm add @auth/core
```

The preset calls the real Auth.js v5 encoder lazily. It creates the encrypted
session JWE that `getToken` accepts; a conventional signed JWT is not enough.

```ts
import { authJsPreset } from "@vendoai/actions/presets";

export const actAs = authJsPreset({
  // Defaults to process.env.AUTH_SECRET.
  secret: () => process.env.AUTH_SECRET,

  // Match the host's real cookie. Use secureCookie for Auth.js's production
  // default, or set cookieName explicitly when the host customizes it.
  secureCookie: process.env.NODE_ENV === "production",

  claims: async (principal) => {
    const user = await db.user.findUnique({ where: { id: principal.subject } });
    if (!user || user.disabled) return null;
    return { name: user.name, email: user.email };
  },
});
```

`cookieName` is also the JWE key-derivation salt, so it must match exactly. The
defaults are `authjs.session-token` and, with `secureCookie: true`,
`__Secure-authjs.session-token`.

## Supabase Auth

Use the project's server-only legacy JWT secret. The preset mints an HS256
access token offline with `sub`, `role: "authenticated"`, `aud`, `iat`, and
`exp`, then sends it as `Authorization: Bearer ...`.

```ts
import { supabasePreset } from "@vendoai/actions/presets";

export const actAs = supabasePreset({
  // Defaults to process.env.SUPABASE_JWT_SECRET.
  secret: () => process.env.SUPABASE_JWT_SECRET,
  audience: "authenticated",
  role: "authenticated",
  expiresInSeconds: 300,
  claims: async (principal) => {
    const profile = await loadProfile(principal.subject);
    if (!profile || profile.disabled) return null;
    return { email: profile.email };
  },
});
```

Do not pass the Supabase anon key or service-role token. Those are complete
tokens, not the project JWT signing secret.

## Clerk and Auth0

Clerk and Auth0 hold the private keys for their RS256 user sessions, so a host
cannot honestly mint a provider session offline. Their presets instead issue a
short-lived, host-owned HS256 `VendoAway` token. The host API accepts that token
only through the shipped verifier; ordinary browser requests continue through
the existing Clerk or Auth0 verifier.

Create a separate random server secret and deploy the same value to the Vendo
runtime and host API:

```sh
openssl rand -base64 32
```

```ts
// lib/vendo-away.ts
import { clerkPreset } from "@vendoai/actions/presets";
// Use auth0Preset with identical options in an Auth0 host.

export const awayAuth = clerkPreset({
  // Defaults to process.env.VENDO_AWAY_TOKEN_SECRET.
  secret: () => process.env.VENDO_AWAY_TOKEN_SECRET,
  issuer: "my-product",
  audience: "my-product-api",
  expiresInSeconds: 120,
  claims: async (principal) => {
    const user = await loadUser(principal.subject);
    if (!user || user.disabled) return null;
    return { tenantId: user.tenantId };
  },
});

export const actAs = awayAuth.actAs;
```

The token binds `sub`, provider, grant id, and tool in addition to issuer,
audience, issued-at, and expiry. `awayAuth.verify(value)` accepts either the
compact token or the complete `VendoAway ...` authorization value, which also
makes a mint-and-verify doctor probe straightforward.

### Next.js verifier

Install `next` only in a Next.js host; it is an optional peer and is imported
only when `nextMiddleware` runs.

```ts
// middleware.ts
import { clerkPreset } from "@vendoai/actions/presets";

// A verifier-only instance keeps database-backed producer claims out of an
// Edge middleware bundle. Keep these values identical to lib/vendo-away.ts.
const awayVerifier = clerkPreset({
  secret: () => process.env.VENDO_AWAY_TOKEN_SECRET,
  issuer: "my-product",
  audience: "my-product-api",
});

export const middleware = awayVerifier.nextMiddleware;
export const config = { matcher: ["/api/:path*"] };
```

For a valid away-token the middleware adds these request headers:
`x-vendo-away-subject`, `x-vendo-away-provider`, `x-vendo-away-grant`, and
`x-vendo-away-tool`. It removes caller-supplied versions first, including on
ordinary requests. Trust these headers only on routes covered by this
middleware, then branch to the provider's normal verifier for present traffic:

```ts
import { headers } from "next/headers";

export async function GET() {
  const requestHeaders = await headers();
  const awaySubject = requestHeaders.get("x-vendo-away-subject");
  const subject = awaySubject ?? (await requireProviderSession()).userId;
  return Response.json(await loadAccount(subject));
}
```

Invalid `VendoAway` tokens return 401. `Bearer` and cookie-based provider auth
pass through for the host's existing verifier.

### Express verifier

Mount the middleware before protected API routes. Verified claims are attached
to `req.vendoAwayToken`; a malformed or expired away-token returns 401. Like
the Next.js flavor, it removes caller-supplied `x-vendo-away-*` headers from
every request, so only `req.vendoAwayToken` carries away identity.

```ts
import { awayAuth } from "./vendo-away.js";

app.use("/api", awayAuth.expressMiddleware);
app.get("/api/account", async (req, res) => {
  const subject = req.vendoAwayToken?.sub ?? (await requireProviderSession(req)).userId;
  res.json(await loadAccount(subject));
});
```

If TypeScript owns the Express request type, merge the field once:

```ts
import type { AwayTokenClaims } from "@vendoai/actions/presets";

declare global {
  namespace Express {
    interface Request {
      vendoAwayToken?: AwayTokenClaims;
    }
  }
}
```

## Generic JWT recipes

`genericJwtPreset` covers host-owned HS256 schemes and long-tail providers that
accept a shared-secret JWT. It always forces `alg: "HS256"`, `iat`, and `exp`.

### Bearer token

```ts
import { genericJwtPreset } from "@vendoai/actions/presets";

export const actAs = genericJwtPreset({
  secret: () => process.env.HOST_API_JWT_SECRET,
  jwtHeader: { typ: "at+jwt", kid: "current" },
  claims: async (principal, grant) => {
    const account = await loadAccount(principal.subject);
    if (!account?.active) return null;
    return {
      sub: account.providerUserId,
      aud: "host-api",
      tenant: account.tenantId,
      permission: grant.tool,
    };
  },
});
```

### Custom header or cookie

```ts
export const actAs = genericJwtPreset({
  secret: process.env.HOST_API_JWT_SECRET,
  claims: (principal) => ({ sub: principal.subject, aud: "internal-api" }),
  headers: (token) => ({
    "x-internal-session": token,
    cookie: `internal_session=${token}`,
  }),
});
```

For managed asymmetric providers that do not expose a signing key, do not put a
provider public key into `genericJwtPreset`: a public key cannot sign. Use the
Clerk/Auth0 away-token pattern above, or implement the same two-sided pattern
in the host with a dedicated server secret and a distinct authorization
scheme.

## Cache and rotation controls

All presets default to a five-minute token and a 30-second cache safety margin.
Use `expiresInSeconds` and `cacheSafetySeconds` to tune them. Secret resolvers
run on every call, so rotating the returned secret immediately changes the
cache key and minted token. Claims resolvers also run on every call so a
disabled or deleted user can decline even while an older token remains cached.
