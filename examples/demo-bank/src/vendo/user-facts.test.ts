import { encode } from "next-auth/jwt";
import { describe, expect, it } from "vitest";
import { mapleAuth } from "./server";

/** Spec 2026-08-05 §1 — Maple asserts [User] facts for the signed-in customer
 * through the authJs preset's user resolver (real Auth.js session in, facts out). */

const DEV_SECRET = "maple-local-development-auth-secret";
const COOKIE = "authjs.session-token";

async function sessionRequest(sub: string): Promise<Request> {
  const token = await encode({ token: { sub }, secret: DEV_SECRET, salt: COOKIE, maxAge: 300 });
  return new Request("http://localhost:3000/api/vendo/threads", { headers: { cookie: `${COOKIE}=${token}` } });
}

describe("Maple [User] facts", () => {
  it("asserts name/email/role for the org admin", async () => {
    await expect(mapleAuth.facts?.(await sessionRequest("vendo-demo"))).resolves.toEqual({
      name: "Yousef Helal",
      email: "yousef@maple.com",
      role: "org admin",
    });
  });

  it("asserts member role for ordinary staff", async () => {
    await expect(mapleAuth.facts?.(await sessionRequest("maple-mia"))).resolves.toEqual({
      name: "Mia Nakamura",
      email: "mia@maple.com",
      role: "member",
    });
  });

  it("asserts nothing for a subject Maple never issued", async () => {
    await expect(mapleAuth.facts?.(await sessionRequest("ghost"))).resolves.toBeUndefined();
  });
});
