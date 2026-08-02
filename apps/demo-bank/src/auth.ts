import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { withBasePath } from "@/lib/base-path";
import { authenticateMapleUser, authSecret, isSecureDeployment } from "@/server/users";

/**
 * Maple's real Auth.js setup: the credentials provider over the seeded demo
 * users, JWT sessions. The session cookie is a real Auth.js JWE minted with
 * `AUTH_SECRET` — the same secret vendo/server.ts's `auth: authJs({ secret:
 * authSecret, ... })` uses for the principal/actAs/oauth seams.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  // Lazy config: the secret is resolved per request, not at import, so
  // `next build` (which imports routes under NODE_ENV=production) never trips
  // the missing-AUTH_SECRET guard.
  secret: authSecret(),
  // Railway terminates TLS before Next.js; trust x-forwarded-* like the door does.
  trustHost: true,
  // Keep the cookie name deterministic (VENDO_BASE_URL is the operator-set
  // public origin) so session reads and away minting agree on it.
  useSecureCookies: isSecureDeployment(),
  session: { strategy: "jwt" },
  // `basePath` deliberately stays the DEFAULT "/api/auth" even though Maple is
  // now served under a mount point: Next strips the basePath from `request.url`
  // before a route handler sees it (probed on the real server — the handler is
  // handed `/api/auth/session`, not `/maple/api/auth/session`), so a prefixed
  // value matches nothing and every Auth.js route answers 400.
  //
  // `signIn` is the opposite case: it is a BROWSER path, emitted verbatim as a
  // Location, and Next does not add the prefix back on the way out. Same reason
  // `signIn({ redirectTo })` in app/login/route.ts carries it.
  pages: { signIn: withBasePath("/login") },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (credentials) => {
        const user = await authenticateMapleUser(
          typeof credentials?.email === "string" ? credentials.email : "",
          typeof credentials?.password === "string" ? credentials.password : "",
        );
        return user ? { id: user.subject, name: user.display, email: user.email } : null;
      },
    }),
  ],
}));
