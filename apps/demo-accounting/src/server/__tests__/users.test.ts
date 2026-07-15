import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cadenceDemoEmail,
  cadenceDemoPassword,
  cadenceDemoUsers,
  isSecureDeployment,
  resolveCadenceSubject,
  supabaseAnonKey,
  supabaseJwtSecret,
  supabaseUrl,
} from "../users"

afterEach(() => vi.unstubAllEnvs())

describe("seeded Cadence identities", () => {
  it("seeds two demo users with fixed Supabase user ids", () => {
    const users = cadenceDemoUsers()
    expect(users).toHaveLength(2)
    for (const user of users) {
      // Supabase auth.users.id is a uuid; the seed pins them so offline JWT
      // verification, actAs claims, and supabase/seed.sql all agree.
      expect(user.subject).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(user.email).toContain("@")
      expect(user.display.length).toBeGreaterThan(0)
    }
    expect(new Set(users.map(u => u.subject)).size).toBe(2)
  })

  it("resolves seeded subjects and rejects strangers", () => {
    const [maya] = cadenceDemoUsers()
    expect(resolveCadenceSubject(maya!.subject)).toMatchObject({ email: maya!.email })
    expect(resolveCadenceSubject("2f0c53a1-0000-4000-8000-000000000000")).toBeNull()
    expect(resolveCadenceSubject("")).toBeNull()
  })

  it("prefills the primary demo login", () => {
    expect(cadenceDemoEmail()).toBe(cadenceDemoUsers()[0]!.email)
    expect(cadenceDemoPassword().length).toBeGreaterThan(0)
  })
})

describe("Supabase environment", () => {
  it("defaults to the Supabase local stack outside production", () => {
    expect(supabaseUrl()).toBe("http://127.0.0.1:54321")
    // The well-known supabase-local development secret — never valid in prod.
    expect(supabaseJwtSecret()).toBe("super-secret-jwt-token-with-at-least-32-characters-long")
    expect(supabaseAnonKey().split(".")).toHaveLength(3)
  })

  it("prefers configured values", () => {
    vi.stubEnv("SUPABASE_URL", "https://demo.supabase.co")
    vi.stubEnv("SUPABASE_JWT_SECRET", "configured-secret-value-with-enough-length")
    vi.stubEnv("SUPABASE_ANON_KEY", "configured.anon.key")
    expect(supabaseUrl()).toBe("https://demo.supabase.co")
    expect(supabaseJwtSecret()).toBe("configured-secret-value-with-enough-length")
    expect(supabaseAnonKey()).toBe("configured.anon.key")
  })

  it("refuses to fall back to development defaults in production", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(() => supabaseJwtSecret()).toThrow(/SUPABASE_JWT_SECRET/)
    expect(() => supabaseAnonKey()).toThrow(/SUPABASE_ANON_KEY/)
  })

  it("derives cookie security from the operator-set public origin", () => {
    expect(isSecureDeployment()).toBe(false)
    vi.stubEnv("VENDO_BASE_URL", "https://cadence.example.com")
    expect(isSecureDeployment()).toBe(true)
    vi.stubEnv("VENDO_BASE_URL", "http://localhost:3000")
    expect(isSecureDeployment()).toBe(false)
    vi.stubEnv("VENDO_BASE_URL", "not a url")
    expect(isSecureDeployment()).toBe(false)
  })
})
