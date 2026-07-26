/**
 * Nightly login canary (demo-hygiene, criterion 31 — tier 4, never blocks):
 * proves the HOSTED Cadence Supabase still accepts the seeded demo
 * credentials, catching password/seed drift before a prospect does.
 *
 * Runs ONLY when explicitly armed: CADENCE_CANARY=1 plus the hosted stack's
 * env (SUPABASE_URL + SUPABASE_ANON_KEY, and CADENCE_DEMO_PASSWORD when the
 * hosted seed overrides the default). Green is silent; red names the exact
 * user and GoTrue verdict. Ordinary `pnpm test` runs skip it entirely, so it
 * can never block CI.
 *
 * One-shot invocation (the mini's nightly job runs exactly this):
 *   CADENCE_CANARY=1 SUPABASE_URL=... SUPABASE_ANON_KEY=... \
 *     pnpm --filter demo-accounting exec vitest run src/vendo/login-canary.test.ts
 */
import { describe, expect, it } from "vitest"
import { cadenceDemoPassword, cadenceDemoUsers, supabaseAnonKey, supabaseUrl } from "../server/users"

const armed = process.env.CADENCE_CANARY === "1"
const configured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
if (armed && !configured) {
  console.warn(
    "login canary: CADENCE_CANARY=1 but SUPABASE_URL/SUPABASE_ANON_KEY are not set — skipping (nothing hosted to probe).",
  )
}

describe.skipIf(!armed || !configured)("Cadence hosted login canary", () => {
  it.each(cadenceDemoUsers().map(user => [user.email, user.subject]))(
    "seeded login succeeds for %s",
    { timeout: 30_000, retry: 2 },
    async (email, subject) => {
      const response = await fetch(new URL("/auth/v1/token?grant_type=password", supabaseUrl()), {
        method: "POST",
        headers: { apikey: supabaseAnonKey(), "content-type": "application/json" },
        body: JSON.stringify({ email, password: cadenceDemoPassword() }),
        signal: AbortSignal.timeout(15_000),
      })
      const body = (await response.json()) as { access_token?: string; sub?: string; error_code?: string; msg?: string }
      expect(
        response.status,
        `hosted login DRIFTED for ${email}: GoTrue answered ${response.status} ` +
          `(${body.error_code ?? "no error_code"}: ${body.msg ?? "no message"}) — ` +
          "re-run the reseed runbook (docs/verification/demo-live-readiness/hygiene/reseed-runbook.md).",
      ).toBe(200)
      expect(body.access_token, `no access_token for ${email}`).toBeTruthy()
      const payload = JSON.parse(
        Buffer.from(body.access_token!.split(".")[1]!, "base64url").toString(),
      ) as { sub: string }
      expect(payload.sub, `login for ${email} resolved to an unexpected Supabase user`).toBe(subject)
    },
  )
})
