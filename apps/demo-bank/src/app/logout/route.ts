import { signOut } from "@/auth";
import { maplePublicUrl } from "@/vendo/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /logout — real Auth.js sign-out: clears the session JWE cookie via
 * next/headers cookies() and throws Next's redirect. POST-only on purpose
 * (a GET logout is a classic drive-by nuisance); the account switcher's
 * "Sign out" posts here and then navigates to /login.
 */
export async function POST(request: Request): Promise<Response> {
  await signOut({ redirect: false });
  return new Response(null, {
    status: 303,
    headers: { location: maplePublicUrl(request, "/login").toString(), "cache-control": "no-store" },
  });
}
