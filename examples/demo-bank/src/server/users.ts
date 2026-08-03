/**
 * Maple's seeded demo identities — real Auth.js authentication with zero
 * external services. Two users are seeded so per-user isolation (threads,
 * grants, approvals) is demonstrable; both share the single demo password so
 * one env knob (`MAPLE_DEMO_PASSWORD`) covers deployment.
 *
 * Everything here must stay edge-safe (Web Crypto + env only): the Next proxy
 * imports this module.
 */

export interface MapleDemoUser {
  subject: string;
  display: string;
  email: string;
}

interface SeededUser extends MapleDemoUser {
  password: string;
}

function production(): boolean {
  return process.env.NODE_ENV === "production";
}

function demoPassword(): string | undefined {
  return process.env.MAPLE_DEMO_PASSWORD ?? (production() ? undefined : "maple-demo");
}

/** WHO the seeded users are, independent of whether password login is
 * configured — auto-login (DEMO_AUTOLOGIN) mints sessions from identity
 * alone, so a deployed demo needs no password env at all. */
function seededIdentities(): MapleDemoUser[] {
  return [
    {
      subject: "vendo-demo",
      display: "Yousef Helal",
      email: (process.env.MAPLE_DEMO_EMAIL ?? "yousef@maple.com").trim().toLowerCase(),
    },
    {
      subject: "maple-mia",
      display: "Mia Nakamura",
      email: "mia@maple.com",
    },
  ];
}

function seededUsers(): SeededUser[] {
  const password = demoPassword();
  if (!password) return [];
  return seededIdentities().map((user) => ({ ...user, password }));
}

/** The seeded users without their password — for UI hints and tests. */
export function mapleDemoUsers(): MapleDemoUser[] {
  return seededUsers().map(({ subject, display, email }) => ({ subject, display, email }));
}

/** The primary seeded user — the identity auto-login signs visitors in as. */
export function primaryMapleUser(): MapleDemoUser {
  return { ...seededIdentities()[0]! };
}

/** The primary demo user's email — login prefill and scripted flows.
 * Deliberately NOT primaryMapleUser().email: when password login is
 * unconfigured this has always returned the raw env value, and flag-absent
 * behavior stays byte-identical. */
export function mapleDemoEmail(): string {
  return seededUsers()[0]?.email ?? (process.env.MAPLE_DEMO_EMAIL ?? "yousef@maple.com");
}

/**
 * Build contract §9.1 companion — Maple's own directory lookup: what someone
 * typed into the Share dialog ("Mia", "mia@maple.com") → one of Maple's own
 * subjects, or null. This is the whole reason the dialog may offer to share with
 * one person; Vendo has no directory to guess from.
 *
 * Answers from the seeded IDENTITIES, not seededUsers: who exists must not
 * depend on whether password login is configured (a deployed demo signs people
 * in through DEMO_AUTOLOGIN with no password env at all).
 */
export function resolveMaplePerson(query: string): MapleDemoUser | null {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return null;
  return seededIdentities().find((user) => {
    const display = user.display.toLowerCase();
    // Email, subject, full name — or a first name, which is what people type.
    return user.email === wanted
      || user.subject.toLowerCase() === wanted
      || display === wanted
      || display.startsWith(`${wanted} `);
  }) ?? null;
}

/** Auth.js subject → seeded user, or null for anything Maple never issued. */
export function resolveMapleSubject(subject: string): MapleDemoUser | null {
  const user = seededUsers().find((candidate) => candidate.subject === subject);
  return user ? { subject: user.subject, display: user.display, email: user.email } : null;
}

/** The Auth.js secret. Falls back to a fixed local secret outside production
 * so the demo boots with zero configuration. */
export function authSecret(): string {
  const configured = process.env.AUTH_SECRET;
  if (configured) return configured;
  if (production()) throw new Error("AUTH_SECRET is required in production");
  return "maple-local-development-auth-secret";
}

/** TLS terminates upstream when the operator-set public base is https; Auth.js
 * then uses its `__Secure-` cookie names. Everything that reads or mints the
 * session cookie derives the name from this one predicate. */
export function isSecureDeployment(): boolean {
  const base = process.env.VENDO_BASE_URL;
  if (!base) return false;
  try {
    return new URL(base).protocol === "https:";
  } catch {
    return false;
  }
}

async function hmac(key: CryptoKey, value: string): Promise<ArrayBuffer> {
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
}

/** Constant-time-ish comparison via HMAC of both sides with an ephemeral key —
 * avoids leaking password length/content through string comparison timing. */
async function passwordMatches(actual: string, expected: string): Promise<boolean> {
  const key = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const expectedSignature = await hmac(key, expected);
  return crypto.subtle.verify(
    "HMAC",
    key,
    expectedSignature,
    new TextEncoder().encode(actual),
  );
}

/** Credentials check for the Auth.js authorize callback. */
export async function authenticateMapleUser(
  email: string,
  password: string,
): Promise<MapleDemoUser | null> {
  const normalized = email.trim().toLowerCase();
  for (const user of seededUsers()) {
    const emailOk = user.email === normalized;
    const passwordOk = await passwordMatches(password, user.password);
    if (emailOk && passwordOk) {
      return { subject: user.subject, display: user.display, email: user.email };
    }
  }
  return null;
}
