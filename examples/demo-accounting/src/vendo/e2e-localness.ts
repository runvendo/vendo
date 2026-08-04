/**
 * Localness guard for the Supabase-backed e2e suites (demo-hygiene,
 * criterion 30): a login e2e that inherits an ambient live SUPABASE_URL must
 * SKIP, not exercise (and rate-limit) a hosted GoTrue — unless the run
 * explicitly opts in with CADENCE_E2E_SUPABASE=live (the nightly canary's
 * posture, never CI's).
 */

export interface LocalnessVerdict {
  run: boolean
  reason?: string
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]"
  } catch {
    return false
  }
}

export function e2eSupabaseGuard(supabaseUrl: string, liveOptIn: string | undefined): LocalnessVerdict {
  if (liveOptIn === "live" || isLoopbackUrl(supabaseUrl)) return { run: true }
  return {
    run: false,
    reason:
      `login-e2e localness guard: SUPABASE_URL (${supabaseUrl}) is not a loopback host and ` +
      "CADENCE_E2E_SUPABASE=live was not set — skipping so an ambient live stack is never exercised.",
  }
}
