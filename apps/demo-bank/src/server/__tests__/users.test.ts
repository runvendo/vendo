import { afterEach, describe, expect, it, vi } from "vitest"
import {
  authenticateMapleUser,
  authSecret,
  isSecureDeployment,
  mapleDemoEmail,
  mapleDemoUsers,
  resolveMapleSubject,
} from "../users"

afterEach(() => vi.unstubAllEnvs())

describe("Maple seeded demo users", () => {
  it("seeds two users so per-user isolation is demonstrable", () => {
    const users = mapleDemoUsers()
    expect(users.map(({ subject }) => subject)).toEqual(["vendo-demo", "maple-mia"])
    expect(new Set(users.map(({ email }) => email)).size).toBe(2)
  })

  it("authenticates both seeded users case-insensitively and rejects bad passwords", async () => {
    vi.stubEnv("MAPLE_DEMO_EMAIL", "demo@maple.test")
    vi.stubEnv("MAPLE_DEMO_PASSWORD", "correct horse battery staple")

    await expect(authenticateMapleUser("DEMO@MAPLE.TEST", "correct horse battery staple"))
      .resolves.toMatchObject({ subject: "vendo-demo", email: "demo@maple.test" })
    await expect(authenticateMapleUser("mia@maple.com", "correct horse battery staple"))
      .resolves.toMatchObject({ subject: "maple-mia" })
    await expect(authenticateMapleUser("demo@maple.test", "wrong")).resolves.toBeNull()
    await expect(authenticateMapleUser("stranger@maple.test", "correct horse battery staple"))
      .resolves.toBeNull()
  })

  it("resolves only subjects Maple issued", () => {
    expect(resolveMapleSubject("vendo-demo")).toMatchObject({ display: "Yousef Helal" })
    expect(resolveMapleSubject("maple-mia")).toMatchObject({ email: "mia@maple.com" })
    expect(resolveMapleSubject("user_stranger")).toBeNull()
  })

  it("keeps the primary email as the login prefill", () => {
    expect(mapleDemoEmail()).toBe("yousef@maple.com")
    vi.stubEnv("MAPLE_DEMO_EMAIL", "Custom@Maple.Test ")
    expect(mapleDemoEmail()).toBe("custom@maple.test")
  })

  it("falls back to the local AUTH_SECRET outside production and requires it in production", () => {
    expect(authSecret()).toBe("maple-local-development-auth-secret")
    vi.stubEnv("AUTH_SECRET", "operator-secret")
    expect(authSecret()).toBe("operator-secret")
    vi.stubEnv("AUTH_SECRET", "")
    vi.stubEnv("NODE_ENV", "production")
    expect(() => authSecret()).toThrow(/AUTH_SECRET/)
  })

  it("derives cookie security from the operator-set public base", () => {
    expect(isSecureDeployment()).toBe(false)
    vi.stubEnv("VENDO_BASE_URL", "http://localhost:3000")
    expect(isSecureDeployment()).toBe(false)
    vi.stubEnv("VENDO_BASE_URL", "https://maple.example.com")
    expect(isSecureDeployment()).toBe(true)
    vi.stubEnv("VENDO_BASE_URL", "not a url")
    expect(isSecureDeployment()).toBe(false)
  })
})
