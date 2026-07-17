/**
 * Cadence's seeded demo identities and Supabase environment knobs.
 *
 * Authentication itself is real Supabase Auth (GoTrue verifies passwords);
 * this module only pins WHO the seeded users are so `supabase/seed.sql`,
 * offline session verification, and away-execution actAs claims all agree on
 * the same fixed Supabase user ids.
 *
 * Everything here must stay edge-safe (env only): the Next proxy imports it.
 */

export interface CadenceDemoUser {
  /** The Supabase auth.users.id — the Vendo principal subject. */
  subject: string
  display: string
  email: string
}

/** Fixed uuids matching supabase/seed.sql — regenerate both together. */
const SEEDED_USERS: CadenceDemoUser[] = [
  {
    subject: "8d0158a1-bf6c-4e32-9dc4-8b17c1e14a01",
    display: "Maya Alvarez",
    email: "maya@cadence.test",
  },
  {
    subject: "3d2f5e0c-9b1a-4c8d-8e4f-2a6b7c9d1e02",
    display: "Daniel Hartwell",
    email: "daniel@cadence.test",
  },
]

function production(): boolean {
  return process.env.NODE_ENV === "production"
}

export function cadenceDemoUsers(): CadenceDemoUser[] {
  return SEEDED_USERS.map(user => ({ ...user }))
}

/** The primary demo user's email — login prefill and scripted flows. */
export function cadenceDemoEmail(): string {
  return process.env.CADENCE_DEMO_EMAIL?.trim().toLowerCase() || SEEDED_USERS[0]!.email
}

/** Both seeded users share one password. It is baked into supabase/seed.sql
 * for the local stack; override the hint (hosted Supabase, different seeds)
 * with CADENCE_DEMO_PASSWORD. */
export function cadenceDemoPassword(): string {
  return process.env.CADENCE_DEMO_PASSWORD ?? "cadence-demo"
}

/** Supabase user id → seeded user, or null for anything Cadence never seeded. */
export function resolveCadenceSubject(subject: string): CadenceDemoUser | null {
  return SEEDED_USERS.find(user => user.subject === subject) ?? null
}

/** The Supabase project URL. Defaults to the `supabase start` local stack. */
export function supabaseUrl(): string {
  return process.env.SUPABASE_URL ?? "http://127.0.0.1:54321"
}

/**
 * The project's (legacy) JWT secret: GoTrue signs access tokens with it, the
 * proxy/session verifier checks them offline against it, and away execution
 * mints real user JWTs with it through the Supabase actAs preset. The
 * development default is the well-known `supabase start` secret — worthless
 * outside a local stack, so production requires an explicit value.
 */
export function supabaseJwtSecret(): string {
  const configured = process.env.SUPABASE_JWT_SECRET
  if (configured) return configured
  if (production()) throw new Error("SUPABASE_JWT_SECRET is required in production")
  return "super-secret-jwt-token-with-at-least-32-characters-long"
}

/** The anon (publishable) key the login route presents to GoTrue. The
 * development default is the well-known `supabase start` demo anon key. */
export function supabaseAnonKey(): string {
  const configured = process.env.SUPABASE_ANON_KEY
  if (configured) return configured
  if (production()) throw new Error("SUPABASE_ANON_KEY is required in production")
  return (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    "eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9." +
    "CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
  )
}

/** TLS terminates upstream when the operator-set public base is https; the
 * session cookie is then marked Secure. Everything that reads or writes the
 * cookie derives its attributes from this one predicate. */
export function isSecureDeployment(): boolean {
  const base = process.env.VENDO_BASE_URL
  if (!base) return false
  try {
    return new URL(base).protocol === "https:"
  } catch {
    return false
  }
}
