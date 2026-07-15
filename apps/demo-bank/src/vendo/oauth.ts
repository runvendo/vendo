import type { HostOAuthAdapter } from "@vendoai/vendo";
import { maplePublicUrl, resolveMapleSession, resolveMapleSubject } from "./auth";

/** Maple supplies only host session lookup and subject resolution. The door
 * owns and renders the default consent page, plus CSRF/replay/redirect logic. */
export const mapleOAuthAdapter: HostOAuthAdapter = {
  async session(request, { returnTo }) {
    const user = await resolveMapleSession(request);
    if (user) return { subject: user.subject };

    const login = maplePublicUrl(request, "/login");
    login.searchParams.set("returnTo", returnTo);
    return Response.redirect(login);
  },

  async principal(subject) {
    const user = resolveMapleSubject(subject);
    return user ? { kind: "user", subject: user.subject, display: user.display } : null;
  },
};
